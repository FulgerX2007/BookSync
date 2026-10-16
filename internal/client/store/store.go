// Package store keeps the client's local state (session, sync state and the
// local bookmark tree) in one sealed file.
//
// The state is sealed with AES-256-GCM under a random data key. Only that
// 32-byte key goes through the platform KeyWrapper (on Android a Keystore
// key that cannot be exported), so large trees never pass through the
// keystore. If the data key cannot be unwrapped (for example after a backup
// was restored onto another phone) the state is unreadable: the files are
// moved aside, Load reports state_unreadable once, and the client starts
// signed out. It never crashes on bad state.
package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/FulgerX2007/BookSync/internal/client/merge"
	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

// CodeStateUnreadable reports that the stored state was discarded.
const CodeStateUnreadable = "state_unreadable"

// Error is a store failure with a stable code.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return "store: " + e.Message }

// CodeOf returns the code of a store *Error in err's chain, or "".
func CodeOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// KeyWrapper protects the data key with a platform key (Android Keystore).
type KeyWrapper interface {
	Wrap(dataKey []byte) ([]byte, error)
	Unwrap(wrapped []byte) ([]byte, error)
}

const (
	keyFile   = "key.bin"
	stateFile = "state.bin"
	dataKeyN  = 32
	ivN       = 12
	stateAAD  = "booksync-android/state/v1"
	// Format is the state file format.
	Format = 1
)

// Session is a signed-in account on this device. VaultKey and DeviceToken
// are the secrets a 401 clears; the rest lets the user sign in again.
type Session struct {
	ServerURL       string `json:"serverUrl"`
	Username        string `json:"username"`
	UserID          string `json:"userId"`
	DeviceID        string `json:"deviceId"`
	DeviceToken     string `json:"deviceToken"`
	SyncID          []byte `json:"syncId"`
	Iterations      int    `json:"iterations"`
	WrappedVaultKey []byte `json:"wrappedVaultKey"`
	VaultKey        []byte `json:"vaultKey"`
}

// Rollback records a detected server rollback awaiting the user's choice.
// RemoteSeq is nil when the server's vault was emptied.
type Rollback struct {
	RemoteVersion int64  `json:"remoteVersion"`
	RemoteSeq     *int64 `json:"remoteSeq"`
	LastSeq       int64  `json:"lastSeq"`
}

// Sync is the sync state of protocol §4 and §6.
type Sync struct {
	// Base is the last vault synced; nil before the first sync.
	Base                *vault.Doc     `json:"base"`
	Version             int64          `json:"version"`
	LastSeq             int64          `json:"lastSeq"`
	Status              string         `json:"status"`
	LastError           string         `json:"lastError"`
	LastSyncAt          int64          `json:"lastSyncAt"`
	PendingConfirmation *merge.Pending `json:"pendingConfirmation"`
	Rollback            *Rollback      `json:"rollback"`
}

// State is everything the client persists.
type State struct {
	Format  int        `json:"format"`
	Session *Session   `json:"session"`
	Sync    Sync       `json:"sync"`
	Local   *vault.Doc `json:"local"`
	// LocalRev increases with every local edit; a sync commits only if it is
	// unchanged since the sync read the local tree.
	LocalRev int64 `json:"localRev"`
}

// NewState is the state of a signed-out device.
func NewState() *State {
	return &State{Format: Format, Local: vault.NewEmpty()}
}

// ClearSession forgets everything: the account, sync state and the local
// tree (sign-out).
func (s *State) ClearSession() {
	rev := s.LocalRev
	*s = *NewState()
	s.LocalRev = rev + 1 // any sync in flight must not commit
}

// ClearCredentials forgets only the device token and the vault key (a 401).
// base, version, lastSeq and the local tree stay, so signing in again resumes
// a three-way merge.
func (s *State) ClearCredentials() {
	if s.Session != nil {
		s.Session.DeviceToken = ""
		s.Session.VaultKey = nil
	}
}

// Store reads and writes the sealed state in one directory.
type Store struct {
	dir        string
	aead       cipher.AEAD
	unreadable bool
}

// Open prepares dir, loading or creating the data key.
func Open(dir string, kw KeyWrapper) (*Store, error) {
	if kw == nil {
		return nil, errors.New("store: a KeyWrapper is required")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir}
	key, err := s.loadKey(kw)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	if s.aead, err = cipher.NewGCM(block); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) loadKey(kw KeyWrapper) ([]byte, error) {
	wrapped, err := os.ReadFile(s.path(keyFile))
	switch {
	case err == nil:
		key, uerr := kw.Unwrap(wrapped)
		if uerr == nil && len(key) == dataKeyN {
			return key, nil
		}
		// The platform key is gone or changed: the state can never be read.
		s.quarantine(keyFile, stateFile)
		s.unreadable = true
	case !errors.Is(err, fs.ErrNotExist):
		return nil, err
	}
	key := make([]byte, dataKeyN)
	_, _ = rand.Read(key) // crypto/rand.Read never fails on supported platforms
	wrapped, err = kw.Wrap(key)
	if err != nil {
		return nil, fmt.Errorf("store: wrapping the data key: %w", err)
	}
	if err := writeAtomic(s.dir, keyFile, wrapped); err != nil {
		return nil, err
	}
	return key, nil
}

// Load returns the stored state, or a fresh one if none exists. If the
// state was unreadable it returns a fresh state together with a
// state_unreadable error, once.
func (s *Store) Load() (*State, error) {
	if s.unreadable {
		s.unreadable = false
		return NewState(), &Error{Code: CodeStateUnreadable, Message: "the saved state could not be unlocked and was reset"}
	}
	sealed, err := os.ReadFile(s.path(stateFile))
	if errors.Is(err, fs.ErrNotExist) {
		return NewState(), nil
	}
	if err != nil {
		return nil, err
	}
	st, err := s.decode(sealed)
	if err != nil {
		s.quarantine(stateFile)
		return NewState(), &Error{Code: CodeStateUnreadable, Message: "the saved state was damaged and was reset"}
	}
	return st, nil
}

func (s *Store) decode(sealed []byte) (*State, error) {
	if len(sealed) < ivN+s.aead.Overhead() {
		return nil, errors.New("truncated")
	}
	plain, err := s.aead.Open(nil, sealed[:ivN], sealed[ivN:], []byte(stateAAD))
	if err != nil {
		return nil, err
	}
	var st State
	if err := json.Unmarshal(plain, &st); err != nil {
		return nil, err
	}
	if st.Format != Format {
		return nil, fmt.Errorf("unknown state format %d", st.Format)
	}
	if st.Local == nil {
		st.Local = vault.NewEmpty()
	}
	return &st, nil
}

// Save seals and atomically replaces the state.
func (s *Store) Save(st *State) error {
	st.Format = Format
	plain, err := json.Marshal(st)
	if err != nil {
		return err
	}
	iv := make([]byte, ivN)
	_, _ = rand.Read(iv)
	return writeAtomic(s.dir, stateFile, s.aead.Seal(iv, iv, plain, []byte(stateAAD)))
}

func (s *Store) path(name string) string { return filepath.Join(s.dir, name) }

// quarantine moves damaged files aside for diagnosis instead of deleting them.
func (s *Store) quarantine(names ...string) {
	suffix := ".unreadable-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	for _, n := range names {
		_ = os.Rename(s.path(n), s.path(n+suffix))
	}
}

// rename is os.Rename; tests replace it to simulate a crash before the swap.
var rename = os.Rename

// writeAtomic writes name via a synced temp file and a rename, then syncs
// the directory, so a crash leaves either the old or the new file.
func writeAtomic(dir, name string, data []byte) error {
	f, err := os.CreateTemp(dir, name+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() { _ = os.Remove(tmp) }() // no-op after a successful rename
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := rename(tmp, filepath.Join(dir, name)); err != nil {
		return err
	}
	if d, err := os.Open(dir); err == nil { //nolint:gosec // dir is the store's own directory
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}
