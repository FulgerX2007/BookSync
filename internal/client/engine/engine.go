// Package engine is the Android client's core: account session, local edits
// and the sync run of docs/protocol.md §4, adapted to a client whose own
// tree is the bookmark store (there is no browser to project or apply to).
//
// Two locks keep it safe for concurrent callers (UI, sync controller, share
// worker): mu guards the in-memory state for short sections and is never
// held across network calls; runMu makes sync runs single-flight.
package engine

import (
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/FulgerX2007/BookSync/internal/client/api"
	"github.com/FulgerX2007/BookSync/internal/client/crypto"
	"github.com/FulgerX2007/BookSync/internal/client/merge"
	"github.com/FulgerX2007/BookSync/internal/client/ops"
	"github.com/FulgerX2007/BookSync/internal/client/store"
	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

// Engine error codes (beyond those of api, crypto, ops and store).
const (
	CodeNotSignedIn     = "not_signed_in"
	CodeAlreadySignedIn = "already_signed_in"
	CodeDifferentUser   = "different_user"
	CodeInvalidUsername = "invalid_username"
	CodeWeakPassword    = "weak_password"
	CodeLocalNotEmpty   = "local_not_empty"
	CodeBusy            = "busy"
)

// MinPasswordLength is the extension's minimum, in characters.
const MinPasswordLength = 10

// Error is an engine failure with a stable code.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return "engine: " + e.Message }

func fail(code, msg string) error { return &Error{Code: code, Message: msg} }

// CodeOf returns the stable code of any client error in err's chain: the
// engine's own, or those of the api, crypto, ops, store and vault packages.
func CodeOf(err error) string {
	if err == nil {
		return ""
	}
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	for _, f := range []func(error) string{api.CodeOf, crypto.CodeOf, ops.CodeOf, store.CodeOf, vault.CodeOf} {
		if c := f(err); c != "" {
			return c
		}
	}
	return "internal"
}

// Options configure an Engine.
type Options struct {
	// Dir holds the sealed state.
	Dir        string
	KeyWrapper store.KeyWrapper
	// DeviceName is shown in the device list of other clients.
	DeviceName string
	// HTTPClient is used for all server calls; nil means a 60 s timeout.
	HTTPClient *http.Client
	// Now is the clock; nil means time.Now.
	Now func() time.Time
}

// Engine is safe for concurrent use.
type Engine struct {
	opts  Options
	store *store.Store

	mu     sync.Mutex
	state  *store.State
	notice string // a one-time notice for the UI, e.g. state_unreadable

	runMu sync.Mutex

	// beforeCommit, when set by tests, runs right before a sync commits; an
	// error simulates a crash between the upload and the commit.
	beforeCommit func() error
}

// Open loads the state in opts.Dir. A state that cannot be unlocked is
// reset and reported once through Status().Notice.
func Open(opts Options) (*Engine, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.DeviceName == "" {
		opts.DeviceName = "Android"
	}
	st, err := store.Open(opts.Dir, opts.KeyWrapper)
	if err != nil {
		return nil, err
	}
	e := &Engine{opts: opts, store: st}
	state, err := st.Load()
	switch {
	case store.CodeOf(err) == store.CodeStateUnreadable:
		e.notice = store.CodeStateUnreadable
	case err != nil:
		return nil, err
	}
	e.state = state
	return e, nil
}

// Status is what the UI shows.
type Status struct {
	SignedIn bool `json:"signedIn"`
	// NeedsReauth: the server revoked this device (401); bookmarks and sync
	// state are kept until the same account signs in again.
	NeedsReauth bool   `json:"needsReauth"`
	ServerURL   string `json:"serverUrl,omitempty"`
	Username    string `json:"username,omitempty"`
	// SyncStatus is the last run's status (ok, rollback_detected, …).
	SyncStatus          string          `json:"syncStatus,omitempty"`
	LastError           string          `json:"lastError,omitempty"`
	LastSyncAt          int64           `json:"lastSyncAt,omitempty"`
	PendingConfirmation *merge.Pending  `json:"pendingConfirmation,omitempty"`
	Rollback            *store.Rollback `json:"rollback,omitempty"`
	LocalRev            int64           `json:"localRev"`
	// Notice is a one-time message code (state_unreadable), cleared on read.
	Notice string `json:"notice,omitempty"`
}

// Status returns the current status and clears a one-time notice.
func (e *Engine) Status() Status {
	e.mu.Lock()
	defer e.mu.Unlock()
	st := e.state
	s := Status{
		SyncStatus:          st.Sync.Status,
		LastError:           st.Sync.LastError,
		LastSyncAt:          st.Sync.LastSyncAt,
		PendingConfirmation: st.Sync.PendingConfirmation,
		Rollback:            st.Sync.Rollback,
		LocalRev:            st.LocalRev,
		Notice:              e.notice,
	}
	e.notice = ""
	if ss := st.Session; ss != nil {
		s.ServerURL, s.Username = ss.ServerURL, ss.Username
		s.SignedIn = ss.DeviceToken != "" && ss.VaultKey != nil
		s.NeedsReauth = !s.SignedIn
	}
	return s
}

// Tree returns a copy of the local bookmark tree.
func (e *Engine) Tree() *vault.Doc {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.state.Local.Clone()
}

// Edit applies fn to a copy of the local tree and commits it if fn succeeds
// and the result is valid. Editing needs an account (also while it waits for
// re-authentication: the edit syncs after the next sign-in).
func (e *Engine) Edit(fn func(*vault.Doc) error) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.state.Session == nil {
		return fail(CodeNotSignedIn, "sign in to edit bookmarks")
	}
	next := e.state.Local.Clone()
	if err := fn(next); err != nil {
		return err
	}
	if vs := vault.Validate(next); len(vs) > 0 {
		return fail("internal", "edit produced an invalid tree: "+string(vs[0].Kind))
	}
	prev, prevRev := e.state.Local, e.state.LocalRev
	e.state.Local, e.state.LocalRev = next, prevRev+1
	if err := e.store.Save(e.state); err != nil {
		e.state.Local, e.state.LocalRev = prev, prevRev
		return err
	}
	return nil
}

// update runs fn on the state under the lock and saves it.
func (e *Engine) update(fn func(*store.State)) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	fn(e.state)
	return e.store.Save(e.state)
}

// snapshot is a consistent copy of what a network call needs.
type snapshot struct {
	session  store.Session
	local    *vault.Doc
	localRev int64
	sync     store.Sync
}

func (e *Engine) snapshot() (snapshot, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	ss := e.state.Session
	if ss == nil || ss.DeviceToken == "" || ss.VaultKey == nil {
		return snapshot{}, fail(CodeNotSignedIn, "this device is not signed in")
	}
	sy := e.state.Sync
	if sy.Base != nil {
		sy.Base = sy.Base.Clone()
	}
	return snapshot{session: *ss, local: e.state.Local.Clone(), localRev: e.state.LocalRev, sync: sy}, nil
}

func (e *Engine) client(serverURL, token string) (*api.Client, error) {
	c, err := api.New(serverURL, e.opts.HTTPClient)
	if err != nil {
		return nil, err
	}
	c.SetToken(token)
	return c, nil
}

// unauthorized handles a 401: only the token and the vault key go.
func (e *Engine) unauthorized(deviceToken string) {
	_ = e.update(func(s *store.State) {
		// Only if the rejected token is still the current one.
		if s.Session != nil && s.Session.DeviceToken == deviceToken {
			s.ClearCredentials()
			s.Sync.Status = StatusSignedOut
		}
	})
}

// isUnauthorized reports a 401 from the server.
func isUnauthorized(err error) bool { return api.CodeOf(err) == api.CodeUnauthorized }
