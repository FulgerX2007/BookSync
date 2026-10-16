package engine

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"sync"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/client/api"
	"github.com/FulgerX2007/BookSync/internal/client/crypto"
	"github.com/FulgerX2007/BookSync/internal/client/merge"
	"github.com/FulgerX2007/BookSync/internal/client/ops"
	"github.com/FulgerX2007/BookSync/internal/client/store"
	"github.com/FulgerX2007/BookSync/internal/client/testserver"
	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

const (
	getVault = "GET /v1/vault"
	putVault = "PUT /v1/vault"
)

func mustSync(t *testing.T, d *device, opts ...SyncOptions) Result {
	t.Helper()
	var o SyncOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	r := d.Sync(ctx, o)
	if r.Status != StatusOK {
		t.Fatalf("Sync = %+v", r)
	}
	return r
}

// pair is one account with two devices that have both synced once.
func pair(t *testing.T) (*testserver.Server, *device, *device) {
	t.Helper()
	srv := testserver.Start(t)
	phone := newDevice(t, "phone")
	kit := mustRegister(t, phone, srv.URL, "alice")
	mustSync(t, phone)
	tablet := newDevice(t, "tablet")
	mustLogin(t, tablet, srv.URL, "alice", kit.SyncID)
	mustSync(t, tablet)
	return srv, phone, tablet
}

// serverDoc downloads and decrypts the current vault with d's keys.
func serverDoc(t *testing.T, srv *testserver.Server, d *device) (*vault.Doc, int64) {
	t.Helper()
	ss := d.currentSession()
	c, _ := api.New(srv.URL, nil)
	c.SetToken(ss.DeviceToken)
	got, err := c.GetVault(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status == api.VaultEmpty {
		return nil, 0
	}
	plain, err := crypto.OpenVault(got.Body, ss.VaultKey, ss.Username)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := vault.Parse(plain)
	if err != nil {
		t.Fatal(err)
	}
	return doc, got.Version
}

// uploadAs writes doc as the next vault version with d's keys, the way
// another client (or a restored backup) would.
func uploadAs(t *testing.T, srv *testserver.Server, d *device, doc *vault.Doc) {
	t.Helper()
	ss := d.currentSession()
	_, version := serverDoc(t, srv, d)
	plain, _ := vault.Marshal(doc)
	env, _ := crypto.SealVault(plain, ss.VaultKey, ss.Username)
	c, _ := api.New(srv.URL, nil)
	c.SetToken(ss.DeviceToken)
	if res, err := c.PutVault(ctx, env, version); err != nil || res.Conflict {
		t.Fatalf("upload: %+v, %v", res, err)
	}
}

func titles(d *vault.Doc, folder vault.GUID) []string {
	var out []string
	for _, g := range d.Nodes[folder].Children {
		out = append(out, d.Nodes[g].Title)
	}
	return out
}

func fakeResponse(r *http.Request, status int, body string, hdr ...string) *http.Response {
	h := http.Header{"Content-Type": {"application/json"}}
	for i := 0; i+1 < len(hdr); i += 2 {
		h.Set(hdr[i], hdr[i+1])
	}
	return &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(bytes.NewBufferString(body)), Request: r}
}

func TestFirstDeviceCreatesVaultAndConvergedRunsAreFree(t *testing.T) {
	t.Parallel()
	srv := testserver.Start(t)
	phone := newDevice(t, "phone")
	mustRegister(t, phone, srv.URL, "alice")

	r := mustSync(t, phone)
	if !r.Uploaded || r.Version != 1 {
		t.Fatalf("first sync = %+v", r)
	}
	doc, _ := serverDoc(t, srv, phone)
	if doc.Seq != 1 || doc.WrittenBy != phone.currentSession().DeviceID || doc.CountNodes() != 0 {
		t.Fatalf("server vault = %+v", doc)
	}

	addBookmark(t, phone, "a")
	if r := mustSync(t, phone); !r.Uploaded || r.Version != 2 {
		t.Fatalf("after edit = %+v", r)
	}
	puts := phone.net.Count[putVault]
	for range 3 {
		if r := mustSync(t, phone); r.Uploaded || r.Changed {
			t.Fatalf("converged run did work: %+v", r)
		}
	}
	if phone.net.Count[putVault] != puts {
		t.Fatal("a converged run uploaded")
	}
	if s := phone.Status(); s.SyncStatus != StatusOK || s.LastSyncAt == 0 {
		t.Fatalf("status = %+v", s)
	}
}

func TestTwoDevicesExchangeEdits(t *testing.T) {
	t.Parallel()
	_, phone, tablet := pair(t)
	g := addBookmark(t, phone, "from-phone")
	mustSync(t, phone)
	if r := mustSync(t, tablet); !r.Changed || tablet.Tree().Nodes[g] == nil {
		t.Fatalf("tablet did not receive the phone's bookmark: %+v", r)
	}
	if err := tablet.Edit(func(d *vault.Doc) error { return ops.Rename(d, g, "renamed on tablet") }); err != nil {
		t.Fatal(err)
	}
	addBookmark(t, phone, "second")
	mustSync(t, tablet)
	mustSync(t, phone)
	mustSync(t, tablet)
	a, b := phone.Tree(), tablet.Tree()
	if !vault.Equal(a, b) || a.Nodes[g].Title != "renamed on tablet" || !slices.Equal(titles(a, vault.RootToolbar), []string{"renamed on tablet", "second"}) {
		t.Fatalf("devices diverged: %v vs %v", titles(a, vault.RootToolbar), titles(b, vault.RootToolbar))
	}
}

// A remote written by a browser with localized root titles must not cause
// an upload: titles of roots are not edits.
func TestLocalizedRootTitlesDoNotUpload(t *testing.T) {
	t.Parallel()
	srv, phone, _ := pair(t)
	doc, _ := serverDoc(t, srv, phone)
	doc.Seq++
	doc.Nodes[vault.RootToolbar].Title = "Lesezeichenleiste"
	doc.Nodes[vault.RootOther].Title = "Weitere Lesezeichen"
	uploadAs(t, srv, phone, doc)
	puts := phone.net.Count[putVault]
	mustSync(t, phone)
	mustSync(t, phone)
	if phone.net.Count[putVault] != puts {
		t.Fatal("localized root titles caused an upload")
	}
}

// An edit made while the upload is in flight is kept: the commit sees the
// new LocalRev, the run restarts and merges the edit with its own upload.
func TestEditDuringUploadSurvives(t *testing.T) {
	t.Parallel()
	srv, phone, _ := pair(t)
	addBookmark(t, phone, "first")
	puts := phone.net.Count[putVault]
	var once sync.Once
	var late vault.GUID
	phone.net.Before = func(r *http.Request) (*http.Response, error) {
		if r.Method == http.MethodPut {
			once.Do(func() { late = addBookmark(t, phone, "during-upload") })
		}
		return nil, nil
	}
	r := mustSync(t, phone)
	if phone.net.Count[putVault]-puts != 2 || !r.Uploaded {
		t.Fatalf("expected a restart with a second upload, got %d PUTs, %+v", phone.net.Count[putVault]-puts, r)
	}
	if phone.Tree().Nodes[late] == nil {
		t.Fatal("the edit made during the upload was lost")
	}
	doc, _ := serverDoc(t, srv, phone)
	if doc.Nodes[late] == nil || !vault.Equal(doc, phone.Tree()) {
		t.Fatal("server does not hold the edit")
	}
}

// Crash after a successful upload but before the commit: the next run must
// recognize its own upload, make no further upload, and converge.
func TestCrashAfterUploadConverges(t *testing.T) {
	t.Parallel()
	srv, phone, _ := pair(t)
	addBookmark(t, phone, "x")
	puts := phone.net.Count[putVault]
	phone.beforeCommit = func() error { return errors.New("process killed") }
	if r := phone.Sync(ctx, SyncOptions{}); r.Status != StatusError || phone.net.Count[putVault]-puts != 1 {
		t.Fatalf("crashed run = %+v", r)
	}
	// A fresh process reads the state as of before the run.
	restarted := openDevice(t, phone.dir, "phone")
	if r := mustSync(t, restarted); r.Uploaded || restarted.net.Count[putVault] != 0 {
		t.Fatalf("the restarted run uploaded again: %+v", r)
	}
	doc, _ := serverDoc(t, srv, restarted)
	if !vault.Equal(doc, restarted.Tree()) {
		t.Fatal("not converged after the crash")
	}
}

func TestFailedUploadDoesNotAdvanceBase(t *testing.T) {
	t.Parallel()
	_, phone, _ := pair(t)
	phone.mu.Lock()
	before := phone.state.Sync
	phone.mu.Unlock()
	addBookmark(t, phone, "x")
	phone.net.Before = func(r *http.Request) (*http.Response, error) {
		if r.Method == http.MethodPut {
			return nil, errors.New("connection reset")
		}
		return nil, nil
	}
	if r := phone.Sync(ctx, SyncOptions{}); r.Status != StatusError || r.Code != api.CodeNetwork {
		t.Fatalf("Sync = %+v", r)
	}
	phone.mu.Lock()
	after := phone.state.Sync
	phone.mu.Unlock()
	if after.Version != before.Version || after.LastSeq != before.LastSeq || !vault.Equal(after.Base, before.Base) || after.Status != StatusError || after.LastError == "" {
		t.Fatalf("base advanced after a failed upload: %+v", after)
	}
	phone.net.Before = nil
	if r := mustSync(t, phone); !r.Uploaded {
		t.Fatal("retry did not upload")
	}
}

func TestConcurrentSyncIsBusy(t *testing.T) {
	t.Parallel()
	_, phone, _ := pair(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	phone.net.Before = func(r *http.Request) (*http.Response, error) {
		if r.Method == http.MethodGet {
			once.Do(func() {
				close(entered)
				<-release
			})
		}
		return nil, nil
	}
	done := make(chan Result)
	go func() { done <- phone.Sync(ctx, SyncOptions{}) }()
	<-entered
	if r := phone.Sync(ctx, SyncOptions{}); r.Status != StatusBusy {
		t.Fatalf("second Sync = %+v", r)
	}
	// Reads and edits stay available while a run waits on the network.
	addBookmark(t, phone, "while-syncing")
	_ = phone.Status()
	close(release)
	if r := <-done; r.Status != StatusOK {
		t.Fatalf("first Sync = %+v", r)
	}
}

// Another device wins the race to upload: the PUT gets 412 and the run
// merges with the newer vault.
func TestVersionConflictRestartsAndMerges(t *testing.T) {
	t.Parallel()
	_, phone, tablet := pair(t)
	a := addBookmark(t, phone, "phone")
	b := addBookmark(t, tablet, "tablet")
	var once sync.Once
	phone.net.Before = func(r *http.Request) (*http.Response, error) {
		if r.Method == http.MethodPut {
			once.Do(func() { mustSync(t, tablet) })
		}
		return nil, nil
	}
	puts := phone.net.Count[putVault]
	mustSync(t, phone)
	if phone.net.Count[putVault]-puts != 2 {
		t.Fatalf("PUTs = %d, want a conflict then a retry", phone.net.Count[putVault]-puts)
	}
	mustSync(t, tablet)
	if !vault.Equal(phone.Tree(), tablet.Tree()) || phone.Tree().Nodes[a] == nil || phone.Tree().Nodes[b] == nil {
		t.Fatal("not merged")
	}
}

func TestConflictExhausted(t *testing.T) {
	t.Parallel()
	_, phone, _ := pair(t)
	addBookmark(t, phone, "x")
	puts := phone.net.Count[putVault]
	phone.net.Before = func(r *http.Request) (*http.Response, error) {
		if r.Method == http.MethodPut {
			return fakeResponse(r, http.StatusPreconditionFailed, `{"error":{"code":"version_conflict","message":"x","currentVersion":1}}`), nil
		}
		return nil, nil
	}
	if r := phone.Sync(ctx, SyncOptions{}); r.Status != StatusConflictExhausted || phone.net.Count[putVault]-puts != MaxAttempts {
		t.Fatalf("Sync = %+v after %d PUTs", r, phone.net.Count[putVault]-puts)
	}
	if phone.Status().SyncStatus != StatusConflictExhausted {
		t.Fatal("status not persisted")
	}
}

func TestRateLimitIsReportedWithRetryAfter(t *testing.T) {
	t.Parallel()
	_, phone, _ := pair(t)
	phone.net.Before = func(r *http.Request) (*http.Response, error) {
		return fakeResponse(r, http.StatusTooManyRequests, `{"error":{"code":"rate_limited","message":"slow down"}}`, "Retry-After", "7"), nil
	}
	if r := phone.Sync(ctx, SyncOptions{}); r.Status != StatusError || r.Code != api.CodeRateLimited || r.RetryAfterMs != 7000 {
		t.Fatalf("Sync = %+v", r)
	}
}

// A server restored from an old backup: seq went backwards.
func TestRollbackBySeq(t *testing.T) {
	t.Parallel()
	for _, choice := range []Recovery{UseLocal, AcceptRemote} {
		t.Run(string(choice), func(t *testing.T) {
			t.Parallel()
			srv, phone, _ := pair(t)
			old, _ := serverDoc(t, srv, phone)
			kept := addBookmark(t, phone, "after-backup")
			mustSync(t, phone)
			mustSync(t, phone)
			lastSeq := phone.state.Sync.LastSeq

			old.Seq = 1 // the restored backup
			uploadAs(t, srv, phone, old)
			r := phone.Sync(ctx, SyncOptions{})
			if r.Status != StatusRollbackDetected || r.RemoteSeq == nil || *r.RemoteSeq != 1 || r.LastSeq != lastSeq {
				t.Fatalf("Sync = %+v", r)
			}
			if s := phone.Status(); s.SyncStatus != StatusRollbackDetected || s.Rollback == nil {
				t.Fatalf("status = %+v", s)
			}
			// Never resolved automatically.
			if r := phone.Sync(ctx, SyncOptions{}); r.Status != StatusRollbackDetected {
				t.Fatalf("second Sync = %+v", r)
			}

			r = phone.ResolveRollback(ctx, choice)
			if r.Status != StatusOK {
				t.Fatalf("ResolveRollback = %+v", r)
			}
			doc, _ := serverDoc(t, srv, phone)
			switch choice {
			case UseLocal:
				if !r.Uploaded || doc.Seq <= lastSeq || doc.Nodes[kept] == nil {
					t.Fatalf("use_local: seq %d (lastSeq %d), kept=%v", doc.Seq, lastSeq, doc.Nodes[kept] != nil)
				}
			case AcceptRemote:
				if phone.Tree().Nodes[kept] != nil || r.Uploaded {
					t.Fatal("accept_remote kept what the backup lacks")
				}
			}
			if s := phone.Status(); s.Rollback != nil || s.SyncStatus != StatusOK {
				t.Fatalf("status after recovery = %+v", s)
			}
			if r := mustSync(t, phone); r.Uploaded {
				t.Fatal("not converged after recovery")
			}
		})
	}
	if r := (&Engine{}).ResolveRollback(ctx, "guess"); r.Status != StatusError {
		t.Fatal("unknown recovery accepted")
	}
}

func TestRollbackByEmptiedVault(t *testing.T) {
	t.Parallel()
	_, phone, _ := pair(t)
	phone.net.Before = func(r *http.Request) (*http.Response, error) {
		if r.Method == http.MethodGet {
			return fakeResponse(r, http.StatusNotFound, `{"error":{"code":"vault_empty","message":"no vault"}}`), nil
		}
		return nil, nil
	}
	r := phone.Sync(ctx, SyncOptions{})
	if r.Status != StatusRollbackDetected || r.RemoteSeq != nil {
		t.Fatalf("Sync = %+v", r)
	}
	if s := phone.Status(); s.Rollback == nil || s.Rollback.RemoteSeq != nil {
		t.Fatalf("status = %+v", s)
	}
}

func TestMassDeletionNeedsConfirmation(t *testing.T) {
	t.Parallel()
	srv, phone, tablet := pair(t)
	err := phone.Edit(func(d *vault.Doc) error {
		for i := range 30 {
			if _, err := ops.AddBookmark(d, vault.RootOther, ops.End, fmt.Sprint(i), fmt.Sprintf("https://%d.example/", i)); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	mustSync(t, phone)
	mustSync(t, tablet)
	_ = tablet.Edit(func(d *vault.Doc) error {
		for _, g := range slices.Clone(d.Nodes[vault.RootOther].Children) {
			if err := ops.Delete(d, g); err != nil {
				return err
			}
		}
		return nil
	})
	r := tablet.Sync(ctx, SyncOptions{})
	if r.Status != StatusNeedsConfirmation || r.Pending.DeletionsToRemote != 30 || r.Pending.DeletionsToLocal != 0 {
		t.Fatalf("Sync = %+v", r)
	}
	if doc, _ := serverDoc(t, srv, tablet); doc.CountNodes() != 30 {
		t.Fatal("deletions uploaded before confirmation")
	}
	// A confirmation for another server version does not cover it.
	stale := *r.Pending
	stale.RemoteVersion = ptr(int64(999))
	if r := tablet.Sync(ctx, SyncOptions{Confirmation: &stale}); r.Status != StatusNeedsConfirmation {
		t.Fatalf("stale confirmation accepted: %+v", r)
	}
	if r := tablet.ConfirmDeletions(ctx); r.Status != StatusOK || !r.Uploaded {
		t.Fatalf("ConfirmDeletions = %+v", r)
	}
	if s := tablet.Status(); s.PendingConfirmation != nil {
		t.Fatal("pending confirmation not cleared")
	}
	// The phone receives 30 deletions toward local: guarded too.
	if r := phone.Sync(ctx, SyncOptions{}); r.Status != StatusNeedsConfirmation || r.Pending.DeletionsToLocal != 30 {
		t.Fatalf("phone Sync = %+v", r)
	}
	if r := phone.ConfirmDeletions(ctx); r.Status != StatusOK || phone.Tree().CountNodes() != 0 {
		t.Fatalf("phone ConfirmDeletions = %+v", r)
	}
	if r := phone.ConfirmDeletions(ctx); r.Status != StatusOK { // nothing pending: a plain sync
		t.Fatalf("ConfirmDeletions with nothing pending = %+v", r)
	}
}

func TestRevokedDuringSyncKeepsState(t *testing.T) {
	t.Parallel()
	srv, phone, tablet := pair(t)
	g := addBookmark(t, phone, "x")
	mustSync(t, phone)
	token, id := session(phone)
	tabletToken, _ := session(tablet)
	revokeDevice(t, srv, tabletToken, id)
	_ = token
	if r := phone.Sync(ctx, SyncOptions{}); r.Status != StatusSignedOut {
		t.Fatalf("Sync = %+v", r)
	}
	s := phone.Status()
	phone.mu.Lock()
	base := phone.state.Sync.Base
	phone.mu.Unlock()
	if !s.NeedsReauth || base == nil || phone.Tree().Nodes[g] == nil {
		t.Fatalf("revocation lost state: %+v", s)
	}
	if r := phone.Sync(ctx, SyncOptions{}); r.Status != StatusError || r.Code != CodeNotSignedIn {
		t.Fatalf("Sync while revoked = %+v", r)
	}
}

func TestFirstSyncRequiresEmptyLocal(t *testing.T) {
	t.Parallel()
	srv := testserver.Start(t)
	phone := newDevice(t, "phone")
	mustRegister(t, phone, srv.URL, "alice")
	addBookmark(t, phone, "before-first-sync")
	if r := phone.Sync(ctx, SyncOptions{}); r.Status != StatusError || r.Code != CodeLocalNotEmpty {
		t.Fatalf("Sync = %+v", r)
	}
	if phone.net.Count[putVault] != 0 {
		t.Fatal("uploaded although the first sync was refused")
	}
	if r := newDevice(t, "x").Sync(ctx, SyncOptions{}); r.Code != CodeNotSignedIn {
		t.Fatalf("signed-out Sync = %+v", r)
	}
}

func TestSecondDeviceAdoptsServerTree(t *testing.T) {
	t.Parallel()
	srv := testserver.Start(t)
	phone := newDevice(t, "phone")
	kit := mustRegister(t, phone, srv.URL, "alice")
	mustSync(t, phone)
	g := addBookmark(t, phone, "x")
	mustSync(t, phone)
	tablet := newDevice(t, "tablet")
	mustLogin(t, tablet, srv.URL, "alice", kit.SyncID)
	r := mustSync(t, tablet)
	if r.Uploaded || !r.Changed || tablet.Tree().Nodes[g] == nil {
		t.Fatalf("adopt = %+v", r)
	}
	tablet.mu.Lock()
	st := tablet.state.Sync
	tablet.mu.Unlock()
	if st.Version != 2 || st.LastSeq != 2 {
		t.Fatalf("sync state = %+v", st)
	}
	_ = merge.Pending{}
	_ = store.Rollback{}
}
