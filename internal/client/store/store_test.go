package store

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/client/merge"
	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

// testWrapper stands in for the Android Keystore: AES-GCM under a fixed key.
type testWrapper struct {
	key       byte
	failWrap  bool
	unwrapErr error
}

func (w *testWrapper) gcm() cipher.AEAD {
	block, _ := aes.NewCipher(bytes.Repeat([]byte{w.key}, 32))
	g, _ := cipher.NewGCM(block)
	return g
}

func (w *testWrapper) Wrap(k []byte) ([]byte, error) {
	if w.failWrap {
		return nil, errors.New("keystore unavailable")
	}
	iv := make([]byte, 12)
	return w.gcm().Seal(iv, iv, k, nil), nil
}

func (w *testWrapper) Unwrap(b []byte) ([]byte, error) {
	if w.unwrapErr != nil {
		return nil, w.unwrapErr
	}
	if len(b) < 12 {
		return nil, errors.New("short")
	}
	return w.gcm().Open(nil, b[:12], b[12:], nil)
}

func sample() *State {
	st := NewState()
	v := int64(4)
	st.Session = &Session{ServerURL: "https://s.example", Username: "alice", DeviceToken: "bst_x", SyncID: []byte{1, 2}, Iterations: 600000, WrappedVaultKey: []byte{3}, VaultKey: []byte{4}}
	st.Local.Nodes["a"] = &vault.Node{GUID: "a", Kind: vault.Bookmark, Title: "A", URL: ""}
	st.Local.Nodes[vault.RootToolbar].Children = []vault.GUID{"a"}
	st.Sync = Sync{Base: st.Local.Clone(), Version: 4, LastSeq: 9, Status: "ok", PendingConfirmation: &merge.Pending{RemoteVersion: &v, DeletionsToLocal: 20}, Rollback: &Rollback{RemoteVersion: 3, RemoteSeq: 2}}
	st.LocalRev = 7
	return st
}

func open(t *testing.T, dir string, w KeyWrapper) *Store {
	t.Helper()
	s, err := Open(dir, w)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	w := &testWrapper{key: 1}
	s := open(t, dir, w)
	if st, err := s.Load(); err != nil || st.Session != nil || len(st.Local.Nodes) != 4 {
		t.Fatalf("fresh Load = %+v, %v", st, err)
	}
	want := sample()
	if err := s.Save(want); err != nil {
		t.Fatal(err)
	}
	// A new process (new Store, same platform key) reads the same state.
	got, err := open(t, dir, w).Load()
	if err != nil {
		t.Fatal(err)
	}
	if got.Session.DeviceToken != "bst_x" || got.LocalRev != 7 || got.Sync.LastSeq != 9 || *got.Sync.PendingConfirmation.RemoteVersion != 4 || got.Sync.Rollback.RemoteSeq != 2 {
		t.Fatalf("state = %+v", got)
	}
	if !vault.Equal(got.Local, want.Local) || !vault.Equal(got.Sync.Base, want.Sync.Base) || got.Local.Nodes["a"].URL != "" {
		t.Fatal("trees differ")
	}
	raw, _ := os.ReadFile(filepath.Join(dir, stateFile))
	if bytes.Contains(raw, []byte("bst_x")) || bytes.Contains(raw, []byte("alice")) {
		t.Fatal("state file is not sealed")
	}
}

func TestCrashBeforeRenameKeepsOldState(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, &testWrapper{key: 1})
	old := sample()
	if err := s.Save(old); err != nil {
		t.Fatal(err)
	}
	defer func(r func(string, string) error) { rename = r }(rename)
	rename = func(string, string) error { return errors.New("power loss") }
	changed := sample()
	changed.LocalRev = 99
	if err := s.Save(changed); err == nil {
		t.Fatal("Save succeeded without the rename")
	}
	rename = os.Rename
	got, err := s.Load()
	if err != nil || got.LocalRev != 7 {
		t.Fatalf("after failed save: rev %d, %v", got.LocalRev, err)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
}

func TestLostPlatformKeyResetsOnce(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, &testWrapper{key: 1})
	if err := s.Save(sample()); err != nil {
		t.Fatal(err)
	}
	// Restored onto another phone: the Keystore key is different.
	s2 := open(t, dir, &testWrapper{key: 2})
	st, err := s2.Load()
	if CodeOf(err) != CodeStateUnreadable || st.Session != nil {
		t.Fatalf("Load = %+v, %v; want a fresh state and state_unreadable", st, err)
	}
	if st, err := s2.Load(); err != nil || st.Session != nil {
		t.Fatalf("second Load = %v", err)
	}
	if err := s2.Save(sample()); err != nil {
		t.Fatal(err)
	}
	if st, err := open(t, dir, &testWrapper{key: 2}).Load(); err != nil || st.Session == nil {
		t.Fatalf("new state not readable: %v", err)
	}
	quarantined, _ := filepath.Glob(filepath.Join(dir, "*.unreadable-*"))
	if len(quarantined) != 2 {
		t.Fatalf("quarantined files = %v", quarantined)
	}
}

func TestDamagedStateResets(t *testing.T) {
	for name, damage := range map[string]func([]byte) []byte{
		"tampered":  func(b []byte) []byte { b[len(b)-1] ^= 1; return b },
		"truncated": func(b []byte) []byte { return b[:5] },
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			s := open(t, dir, &testWrapper{key: 1})
			_ = s.Save(sample())
			p := filepath.Join(dir, stateFile)
			raw, _ := os.ReadFile(p)
			_ = os.WriteFile(p, damage(raw), 0o600)
			if st, err := s.Load(); CodeOf(err) != CodeStateUnreadable || st.Session != nil {
				t.Fatalf("Load = %v", err)
			}
		})
	}
}

func TestUnknownFormatResets(t *testing.T) {
	s := open(t, t.TempDir(), &testWrapper{key: 1})
	st := sample()
	if err := s.Save(st); err != nil {
		t.Fatal(err)
	}
	// Re-seal with an unknown format by hand.
	sealed, _ := os.ReadFile(filepath.Join(s.dir, stateFile))
	plain, _ := s.aead.Open(nil, sealed[:12], sealed[12:], []byte(stateAAD))
	plain = bytes.Replace(plain, []byte(`"format":1`), []byte(`"format":2`), 1)
	iv := make([]byte, 12)
	_ = os.WriteFile(filepath.Join(s.dir, stateFile), s.aead.Seal(iv, iv, plain, []byte(stateAAD)), 0o600)
	if _, err := s.Load(); CodeOf(err) != CodeStateUnreadable {
		t.Fatalf("err = %v", err)
	}
}

func TestOpenErrors(t *testing.T) {
	if _, err := Open(t.TempDir(), nil); err == nil {
		t.Error("nil wrapper accepted")
	}
	if _, err := Open(t.TempDir(), &testWrapper{failWrap: true}); err == nil {
		t.Error("wrap failure ignored")
	}
	file := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(file, nil, 0o600)
	if _, err := Open(filepath.Join(file, "sub"), &testWrapper{}); err == nil {
		t.Error("unusable directory accepted")
	}
	if CodeOf(errors.New("x")) != "" || !strings.HasPrefix((&Error{Message: "m"}).Error(), "store: ") {
		t.Error("CodeOf / Error()")
	}
}

func TestClearSessionAndCredentials(t *testing.T) {
	st := sample()
	st.ClearCredentials()
	if st.Session.DeviceToken != "" || st.Session.VaultKey != nil || st.Session.Username != "alice" || st.Sync.Base == nil || st.Sync.LastSeq != 9 || st.Local.Nodes["a"] == nil {
		t.Fatalf("ClearCredentials = %+v", st)
	}
	st.ClearSession()
	if st.Session != nil || st.Sync.Base != nil || st.Local.Nodes["a"] != nil || st.LocalRev != 8 {
		t.Fatalf("ClearSession = %+v", st)
	}
	NewState().ClearCredentials() // no session: no panic
}
