package engine

import (
	"strings"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/client/api"
	"github.com/FulgerX2007/BookSync/internal/client/crypto"
	"github.com/FulgerX2007/BookSync/internal/client/store"
	"github.com/FulgerX2007/BookSync/internal/client/testserver"
	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

func TestRegisterThenLoginOnSecondDevice(t *testing.T) {
	t.Parallel()
	srv := testserver.Start(t)
	phone := newDevice(t, "phone")
	kit := mustRegister(t, phone, srv.URL+"/", "  Alice ")
	if !strings.HasPrefix(kit.SyncID, "BS1-") || !strings.Contains(kit.Text, "Username:  alice") || strings.Contains(kit.Text, password) || kit.FileName != "booksync-emergency-kit-alice.txt" {
		t.Fatalf("kit = %+v", kit)
	}
	if s := phone.Status(); !s.SignedIn || s.NeedsReauth || s.Username != "alice" || s.ServerURL != srv.URL {
		t.Fatalf("status = %+v", s)
	}

	tablet := newDevice(t, "tablet")
	mustLogin(t, tablet, srv.URL, "alice", strings.ToLower(kit.SyncID))
	a, b := phone.currentSession(), tablet.currentSession()
	if a.UserID != b.UserID || a.DeviceID == b.DeviceID || string(a.VaultKey) != string(b.VaultKey) {
		t.Fatal("second device did not join the same account and vault key")
	}

	// State survives a restart (sealed on disk).
	again := openDevice(t, tablet.dir, "tablet")
	if s := again.Status(); !s.SignedIn || s.Username != "alice" {
		t.Fatalf("after restart: %+v", s)
	}
}

func TestLoginFailures(t *testing.T) {
	t.Parallel()
	srv := testserver.Start(t)
	phone := newDevice(t, "phone")
	kit := mustRegister(t, phone, srv.URL, "alice")
	other, _ := crypto.FormatSyncID(make([]byte, 16))

	tests := []struct {
		name, url, user, pw, syncID, code string
	}{
		{"wrong password", srv.URL, "alice", "wrong password!", kit.SyncID, api.CodeInvalidCredentials},
		{"wrong SyncID", srv.URL, "alice", password, other, api.CodeInvalidCredentials},
		{"unknown user", srv.URL, "nobody", password, kit.SyncID, api.CodeInvalidCredentials},
		{"SyncID typo", srv.URL, "alice", password, kit.SyncID[:len(kit.SyncID)-1] + "Z", crypto.CodeInvalidChecksum},
		{"bad username", srv.URL, "a", password, kit.SyncID, CodeInvalidUsername},
		{"plain http", "http://sync.example.com", "alice", password, kit.SyncID, api.CodeInsecureURL},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			d := newDevice(t, "x")
			if err := d.Login(ctx, tt.url, tt.user, tt.pw, tt.syncID); CodeOf(err) != tt.code {
				t.Fatalf("err = %v (%s), want %s", err, CodeOf(err), tt.code)
			}
			if d.Status().SignedIn || d.currentSession() != nil {
				t.Fatal("a failed login left a session")
			}
		})
	}
	if err := phone.Login(ctx, srv.URL, "alice", password, kit.SyncID); CodeOf(err) != CodeAlreadySignedIn {
		t.Fatalf("login while signed in: %v", err)
	}
}

func TestRegisterFailures(t *testing.T) {
	t.Parallel()
	srv := testserver.Start(t)
	d := newDevice(t, "x")
	for name, tc := range map[string]struct{ user, pw, code string }{
		"short password": {"alice", "short", CodeWeakPassword},
		"bad username":   {"a b", password, CodeInvalidUsername},
	} {
		if _, err := d.Register(ctx, srv.URL, tc.user, tc.pw); CodeOf(err) != tc.code {
			t.Errorf("%s: %v", name, err)
		}
	}
	mustRegister(t, d, srv.URL, "alice")
	if _, err := d.Register(ctx, srv.URL, "bob", password); CodeOf(err) != CodeAlreadySignedIn {
		t.Errorf("register while signed in: %v", err)
	}
	if _, err := newDevice(t, "y").Register(ctx, srv.URL, "alice", password); CodeOf(err) != api.CodeUsernameTaken {
		t.Errorf("taken: %v", err)
	}
}

// A revoked device keeps its bookmarks and sync state; signing in again as
// the same account resumes, and another account is refused.
func TestReauthAfterRevokeKeepsState(t *testing.T) {
	t.Parallel()
	srv := testserver.Start(t)
	phone := newDevice(t, "phone")
	kit := mustRegister(t, phone, srv.URL, "alice")
	tablet := newDevice(t, "tablet")
	mustLogin(t, tablet, srv.URL, "alice", kit.SyncID)
	mustRegister(t, newDevice(t, "z"), srv.URL, "bob")

	g := addBookmark(t, phone, "kept")
	base := vault.NewEmpty()
	base.Seq = 5
	_ = phone.update(func(s *store.State) { s.Sync.Base, s.Sync.Version, s.Sync.LastSeq = base, 3, 5 })

	token, id := session(phone)
	tabletToken, _ := session(tablet)
	revokeDevice(t, srv, tabletToken, id)
	phone.unauthorized(token)

	s := phone.Status()
	if s.SignedIn || !s.NeedsReauth || s.Username != "alice" || s.SyncStatus != StatusSignedOut {
		t.Fatalf("after 401: %+v", s)
	}
	// Still editable offline.
	addBookmark(t, phone, "offline")

	if err := phone.Login(ctx, srv.URL, "bob", password, kit.SyncID); CodeOf(err) != CodeDifferentUser {
		t.Fatalf("other user: %v", err)
	}
	mustLogin(t, phone, srv.URL, "alice", kit.SyncID)
	phone.mu.Lock()
	st := phone.state
	keptBase := st.Sync.Base != nil && st.Sync.Version == 3 && st.Sync.LastSeq == 5 && st.Local.Nodes[g] != nil && len(st.Local.Nodes) == 6
	phone.mu.Unlock()
	if !keptBase {
		t.Fatal("re-login lost base or local bookmarks")
	}
	if s := phone.Status(); !s.SignedIn || s.SyncStatus != "" {
		t.Fatalf("after re-login: %+v", s)
	}
}

func TestLogoutForgetsEverything(t *testing.T) {
	t.Parallel()
	srv := testserver.Start(t)
	phone := newDevice(t, "phone")
	mustRegister(t, phone, srv.URL, "alice")
	addBookmark(t, phone, "x")
	token, _ := session(phone)
	if err := phone.Logout(ctx); err != nil {
		t.Fatal(err)
	}
	if s := phone.Status(); s.SignedIn || s.NeedsReauth || s.Username != "" || len(phone.Tree().Nodes) != 4 {
		t.Fatalf("after logout: %+v", s)
	}
	// The token is revoked server-side.
	c, _ := api.New(srv.URL, nil)
	c.SetToken(token)
	if _, err := c.GetVault(ctx, 0); api.CodeOf(err) != api.CodeUnauthorized {
		t.Fatalf("token still valid: %v", err)
	}
	if err := phone.Edit(func(*vault.Doc) error { return nil }); CodeOf(err) != CodeNotSignedIn {
		t.Fatalf("edit while signed out: %v", err)
	}
	if err := phone.Logout(ctx); err != nil { // idempotent
		t.Fatal(err)
	}
}

func TestEditRollsBackOnError(t *testing.T) {
	t.Parallel()
	srv := testserver.Start(t)
	phone := newDevice(t, "phone")
	mustRegister(t, phone, srv.URL, "alice")
	rev := phone.Status().LocalRev
	err := phone.Edit(func(d *vault.Doc) error {
		d.Nodes[vault.RootToolbar].Title = "changed"
		return fail("nope", "refused")
	})
	if CodeOf(err) != "nope" || phone.Status().LocalRev != rev || phone.Tree().Nodes[vault.RootToolbar].Title != "Bookmarks Toolbar" {
		t.Fatal("failed edit leaked")
	}
	err = phone.Edit(func(d *vault.Doc) error {
		d.Nodes[vault.RootToolbar].Children = append(d.Nodes[vault.RootToolbar].Children, "ghost")
		return nil
	})
	if err == nil || phone.Status().LocalRev != rev {
		t.Fatal("invalid edit committed")
	}
	addBookmark(t, phone, "ok")
	if phone.Status().LocalRev != rev+1 {
		t.Fatal("LocalRev did not advance")
	}
}

func TestUnreadableStateIsReportedOnce(t *testing.T) {
	t.Parallel()
	srv := testserver.Start(t)
	dir := t.TempDir()
	mustRegister(t, openDevice(t, dir, "phone"), srv.URL, "alice")
	e, err := Open(Options{Dir: dir, KeyWrapper: brokenKeystore{}})
	if err != nil {
		t.Fatal(err)
	}
	if s := e.Status(); s.Notice != store.CodeStateUnreadable || s.SignedIn || s.Username != "" {
		t.Fatalf("status = %+v", s)
	}
	if e.Status().Notice != "" {
		t.Fatal("notice repeated")
	}
}

type brokenKeystore struct{ keystore }

func (brokenKeystore) Unwrap([]byte) ([]byte, error) { return nil, errBroken }

var errBroken = fail("keystore", "key permanently invalidated")

func TestCodeOf(t *testing.T) {
	t.Parallel()
	if CodeOf(nil) != "" || CodeOf(fail("x", "y")) != "x" || CodeOf(errBroken) != "keystore" || !strings.HasPrefix(errBroken.Error(), "engine: ") {
		t.Fatal("CodeOf")
	}
	if CodeOf(&api.Error{Code: "a"}) != "a" || CodeOf(&store.Error{Code: "s"}) != "s" || CodeOf(&vault.Error{Code: "v"}) != "v" {
		t.Fatal("CodeOf wraps package errors")
	}
	if CodeOf(strings.NewReader("").UnreadByte()) != "internal" {
		t.Fatal("unknown errors are internal")
	}
}

func TestDeleteAccount(t *testing.T) {
	t.Parallel()
	srv := testserver.Start(t)
	phone := newDevice(t, "phone")
	kit := mustRegister(t, phone, srv.URL, "alice")
	tablet := newDevice(t, "tablet")
	mustLogin(t, tablet, srv.URL, "alice", kit.SyncID)
	addBookmark(t, phone, "x")

	// Wrong confirmations delete nothing and keep the device signed in.
	for name, tc := range map[string]struct{ user, pw, code string }{
		"wrong username": {"bob", password, CodeUsernameMismatch},
		"wrong password": {"alice", "wrong password!", api.CodeInvalidCredentials},
	} {
		if err := phone.DeleteAccount(ctx, tc.user, tc.pw); CodeOf(err) != tc.code {
			t.Fatalf("%s: err = %v, want %s", name, err, tc.code)
		}
		if !phone.Status().SignedIn {
			t.Fatalf("%s: signed out", name)
		}
	}

	if err := phone.DeleteAccount(ctx, " Alice ", password); err != nil {
		t.Fatal(err)
	}
	if s := phone.Status(); s.SignedIn || s.NeedsReauth || s.Username != "" || len(phone.Tree().Nodes) != 4 {
		t.Fatalf("after delete: %+v", s)
	}
	// The account is gone for every device and for new sign-ins.
	if r := tablet.Sync(ctx, SyncOptions{}); r.Status != StatusSignedOut {
		t.Fatalf("tablet Sync = %+v", r)
	}
	if err := newDevice(t, "x").Login(ctx, srv.URL, "alice", password, kit.SyncID); CodeOf(err) != api.CodeInvalidCredentials {
		t.Fatalf("login after delete: %v", err)
	}
	// The name can be registered again.
	mustRegister(t, newDevice(t, "y"), srv.URL, "alice")

	if err := phone.DeleteAccount(ctx, "alice", password); CodeOf(err) != CodeNotSignedIn {
		t.Fatalf("delete while signed out: %v", err)
	}
}
