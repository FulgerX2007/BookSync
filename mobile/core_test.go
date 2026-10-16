package mobile

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/client/engine"
	"github.com/FulgerX2007/BookSync/internal/client/merge"
	"github.com/FulgerX2007/BookSync/internal/client/store"
	"github.com/FulgerX2007/BookSync/internal/client/testserver"
	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

var update = flag.Bool("update", false, "rewrite the Kotlin JSON fixtures")

const password = "correct horse battery"

type keystore struct{}

func (keystore) gcm() cipher.AEAD {
	b, _ := aes.NewCipher(bytes.Repeat([]byte{9}, 32))
	g, _ := cipher.NewGCM(b)
	return g
}

func (k keystore) Wrap(key []byte) ([]byte, error) {
	iv := make([]byte, 12)
	return k.gcm().Seal(iv, iv, key, nil), nil
}

func (k keystore) Unwrap(b []byte) ([]byte, error) {
	if len(b) < 12 {
		return nil, errors.New("short")
	}
	return k.gcm().Open(nil, b[:12], b[12:], nil)
}

func newCore(t *testing.T) *Core {
	t.Helper()
	c, err := NewCore(t.TempDir(), keystore{}, "Pixel")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// code extracts the code Kotlin sees from an error message.
func code(t *testing.T, err error) string {
	t.Helper()
	if err == nil {
		return ""
	}
	var ce CoreError
	if jerr := json.Unmarshal([]byte(err.Error()), &ce); jerr != nil || ce.Code == "" || ce.Message == "" {
		t.Fatalf("error is not CoreError JSON: %q", err.Error())
	}
	return ce.Code
}

func decode[T any](t *testing.T, s string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatalf("decode %s: %v", s, err)
	}
	return v
}

func TestEndToEndThroughTheFacade(t *testing.T) {
	srv := testserver.Start(t)
	phone := newCore(t)

	kit := decode[engine.Kit](t, mustString(t)(phone.Register(srv.URL, "alice", password)))
	if !strings.HasPrefix(kit.SyncID, "BS1-") {
		t.Fatalf("kit = %+v", kit)
	}
	if st := decode[engine.Status](t, phone.Status()); !st.SignedIn || st.Username != "alice" {
		t.Fatalf("status = %+v", st)
	}
	if r := decode[engine.Result](t, phone.Sync()); r.Status != engine.StatusOK || !r.Uploaded {
		t.Fatalf("sync = %+v", r)
	}

	folder := mustString(t)(phone.AddFolder(vault.RootToolbar, "", true, "News"))
	first := mustString(t)(phone.AddBookmark(folder, "", false, "First", "https://first.example/"))
	second := mustString(t)(phone.AddBookmark(folder, first, false, "Second", "https://second.example/"))
	noErr(t, phone.Rename(second, "Second!"))
	noErr(t, phone.SetURL(second, "https://2.example/"))
	noErr(t, phone.Move(first, folder, second, false))
	if got := decode[map[string]int](t, phone.CountSubtree(folder)); got["bookmarks"] != 2 || got["folders"] != 0 {
		t.Fatalf("CountSubtree = %v", got)
	}
	tree, err := phone.Tree()
	noErr(t, err)
	doc, err := vault.Parse([]byte(tree))
	noErr(t, err)
	if kids := doc.Nodes[folder].Children; len(kids) != 2 || kids[0] != second || doc.Nodes[second].URL != "https://2.example/" {
		t.Fatalf("tree = %s", tree)
	}
	if r := decode[engine.Result](t, phone.Sync()); r.Status != engine.StatusOK || !r.Uploaded {
		t.Fatalf("sync = %+v", r)
	}

	tablet := newCore(t)
	noErr(t, tablet.Login(srv.URL, "alice", password, strings.ToLower(kit.SyncID)))
	if r := decode[engine.Result](t, tablet.Sync()); r.Status != engine.StatusOK || !r.Changed {
		t.Fatalf("tablet sync = %+v", r)
	}
	tabletTree, _ := tablet.Tree()
	if tabletTree != tree2(t, phone) {
		t.Fatal("tablet did not receive the phone's tree")
	}

	noErr(t, phone.Delete(folder))
	if r := decode[engine.Result](t, phone.ConfirmDeletions()); r.Status != engine.StatusOK {
		t.Fatalf("ConfirmDeletions = %+v", r)
	}
	if r := decode[engine.Result](t, phone.ResolveRollback("nonsense")); r.Status != engine.StatusError {
		t.Fatalf("ResolveRollback = %+v", r)
	}
	noErr(t, phone.Logout())
	if st := decode[engine.Status](t, phone.Status()); st.SignedIn || st.Username != "" {
		t.Fatalf("after logout: %+v", st)
	}
}

func tree2(t *testing.T, c *Core) string {
	s, err := c.Tree()
	noErr(t, err)
	return s
}

func TestStableErrorCodes(t *testing.T) {
	srv := testserver.Start(t)
	c := newCore(t)
	_, err := c.AddBookmark(vault.RootToolbar, "", true, "x", "https://x/")
	if code(t, err) != engine.CodeNotSignedIn {
		t.Errorf("add while signed out: %v", err)
	}
	if _, err := c.Register("http://example.com", "alice", password); code(t, err) != "insecure_url" {
		t.Errorf("insecure url: %v", err)
	}
	if _, err := c.Register(srv.URL, "alice", "short"); code(t, err) != engine.CodeWeakPassword {
		t.Errorf("weak password: %v", err)
	}
	_, _ = c.Register(srv.URL, "alice", password)
	if err := c.Rename(vault.RootToolbar, "x"); code(t, err) != "root_locked" {
		t.Errorf("rename root: %v", err)
	}
	if err := c.SetURL("missing", "https://x/"); code(t, err) != "stale" {
		t.Errorf("stale: %v", err)
	}
	if _, err := c.AddBookmark(vault.RootToolbar, "", true, "x", "example.com"); code(t, err) != "invalid_url" {
		t.Errorf("invalid url: %v", err)
	}
	if err := c.Login(srv.URL, "alice", password, "BS1-0000"); code(t, err) != "invalid_format" {
		t.Errorf("bad SyncID: %v", err)
	}
	if _, err := ParseSyncID("nope"); code(t, err) != "invalid_format" {
		t.Errorf("ParseSyncID: %v", err)
	}
	if _, err := NewCore(t.TempDir(), nil, "x"); code(t, err) != "invalid_request" {
		t.Errorf("nil wrapper: %v", err)
	}
	if CoreVersion() != Version {
		t.Error("CoreVersion")
	}
}

func TestParseSyncIDCanonicalizes(t *testing.T) {
	c := newCore(t)
	srv := testserver.Start(t)
	kit := decode[engine.Kit](t, mustString(t)(c.Register(srv.URL, "bob", password)))
	got, err := ParseSyncID(" " + strings.ToLower(strings.ReplaceAll(kit.SyncID, "-", "")) + " ")
	if err != nil || got != kit.SyncID {
		t.Fatalf("ParseSyncID = %q, %v; want %q", got, err, kit.SyncID)
	}
}

// --- Kotlin fixtures -----------------------------------------------------------

func fixtureDir() string {
	_, self, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(self), "..", "android", "app", "src", "test", "resources", "fixtures")
}

// fixtures are the JSON shapes Kotlin decodes, rendered with the same
// encoders the facade uses. Kotlin's model tests decode every one.
func fixtures(t *testing.T) map[string]string {
	t.Helper()
	v := int64(7)
	seq := int64(3)
	doc := vault.NewEmpty()
	doc.Seq, doc.WrittenBy, doc.WrittenAt = 12, "device-1", 1760000000000
	doc.Nodes["folder000001"] = &vault.Node{GUID: "folder000001", Kind: vault.Folder, Title: "News ☕", Children: []vault.GUID{"bkmark000001", "empty0000001"}}
	doc.Nodes["bkmark000001"] = &vault.Node{GUID: "bkmark000001", Kind: vault.Bookmark, Title: "Example <b>&</b>", URL: "https://example.com/?a=1&b=2"}
	doc.Nodes["empty0000001"] = &vault.Node{GUID: "empty0000001", Kind: vault.Folder, Title: "", Children: []vault.GUID{}}
	doc.Nodes["bkmark000002"] = &vault.Node{GUID: "bkmark000002", Kind: vault.Bookmark, Title: "No URL", URL: ""}
	doc.Nodes[vault.RootToolbar].Children = []vault.GUID{"folder000001"}
	doc.Nodes[vault.RootMobile].Children = []vault.GUID{"bkmark000002"}
	tree, err := vault.Marshal(doc)
	noErr(t, err)
	pending := &merge.Pending{RemoteVersion: &v, DeletionsToLocal: 25, DeletionsToRemote: 0}
	return map[string]string{
		"tree.json":                    string(tree),
		"kit.json":                     marshal(engine.Kit{Text: "BookSync Emergency Kit\n…", SyncID: "BS1-0000-0000-0000-0000-0000-0000-0000", FileName: "booksync-emergency-kit-alice.txt"}),
		"status-signed-out.json":       marshal(engine.Status{}),
		"status-signed-in.json":        marshal(engine.Status{SignedIn: true, ServerURL: "https://sync.example", Username: "alice", SyncStatus: engine.StatusOK, LastSyncAt: 1760000000000, LocalRev: 4}),
		"status-attention.json":        marshal(engine.Status{NeedsReauth: true, ServerURL: "https://sync.example", Username: "alice", SyncStatus: engine.StatusRollbackDetected, LastError: "x", PendingConfirmation: pending, Rollback: &store.Rollback{RemoteVersion: 7, RemoteSeq: &seq, LastSeq: 9}, Notice: store.CodeStateUnreadable}),
		"sync-ok.json":                 marshal(engine.Result{Status: engine.StatusOK, Uploaded: true, Version: 8, Changed: true}),
		"sync-needs-confirmation.json": marshal(engine.Result{Status: engine.StatusNeedsConfirmation, Pending: pending}),
		"sync-rollback.json":           marshal(engine.Result{Status: engine.StatusRollbackDetected, RemoteSeq: &seq, LastSeq: 9}),
		"sync-rollback-emptied.json":   marshal(engine.Result{Status: engine.StatusRollbackDetected, LastSeq: 9}),
		"sync-error.json":              marshal(engine.Result{Status: engine.StatusError, Code: "rate_limited", Message: "slow down", RetryAfterMs: 7000}),
		"sync-busy.json":               marshal(engine.Result{Status: engine.StatusBusy}),
		"error.json":                   (&CoreError{Code: "invalid_credentials", Message: "username, password or SyncID is incorrect"}).Error(),
		"subtree-count.json":           marshal(map[string]int{"bookmarks": 2, "folders": 1}),
	}
}

func TestKotlinFixtures(t *testing.T) {
	dir := fixtureDir()
	for name, content := range fixtures(t) {
		path := filepath.Join(dir, name)
		if *update {
			noErr(t, os.MkdirAll(dir, 0o755))
			noErr(t, os.WriteFile(path, []byte(content+"\n"), 0o644))
			continue
		}
		got, err := os.ReadFile(path)
		if err != nil || string(got) != content+"\n" {
			t.Errorf("%s is missing or stale; run go test ./... -run TestKotlinFixtures -update in mobile/", name)
		}
	}
}

func mustString(t *testing.T) func(string, error) string {
	return func(s string, err error) string {
		t.Helper()
		noErr(t, err)
		return s
	}
}

func noErr(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
