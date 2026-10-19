package api

import (
	"bytes"
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/config"
)

// envelope returns a syntactically valid vault blob with a recognizable payload.
func envelope(payload string) []byte {
	b := append([]byte("BSV1"), make([]byte, 12)...)
	return append(b, []byte(payload+strings.Repeat("\x00", 16))...)
}

func TestVaultFlow(t *testing.T) {
	e := newTestEnv(t)
	sess := e.register("alice", authKey(1))
	auth := bearer(sess.DeviceToken)

	expectError(t, e.do(http.MethodGet, "/v1/vault", nil, auth...), http.StatusNotFound, codeVaultEmpty)

	// First upload asserts that no vault exists.
	rec := e.do(http.MethodPut, "/v1/vault", envelope("one"), append(auth, "If-None-Match", "*")...)
	if rec.Code != http.StatusOK || rec.Header().Get("ETag") != `"1"` {
		t.Fatalf("first put: %d etag=%q %s", rec.Code, rec.Header().Get("ETag"), rec.Body.String())
	}
	if got := decodeBody[putVaultResponse](t, rec); got.Version != 1 {
		t.Fatalf("version = %d", got.Version)
	}

	rec = e.do(http.MethodGet, "/v1/vault", nil, auth...)
	if rec.Code != http.StatusOK || rec.Header().Get("ETag") != `"1"` || !bytes.Equal(rec.Body.Bytes(), envelope("one")) {
		t.Fatalf("get: %d etag=%q", rec.Code, rec.Header().Get("ETag"))
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Fatalf("content-type = %q", ct)
	}

	rec = e.do(http.MethodPut, "/v1/vault", envelope("two"), append(auth, "If-Match", `"1"`)...)
	if rec.Code != http.StatusOK || rec.Header().Get("ETag") != `"2"` {
		t.Fatalf("second put: %d %s", rec.Code, rec.Body.String())
	}

	// Conditional GET: unchanged → 304 without body; stale tag → full body.
	rec = e.do(http.MethodGet, "/v1/vault", nil, append(auth, "If-None-Match", `"2"`)...)
	if rec.Code != http.StatusNotModified || rec.Body.Len() != 0 || rec.Header().Get("ETag") != `"2"` {
		t.Fatalf("conditional get: %d len=%d", rec.Code, rec.Body.Len())
	}
	rec = e.do(http.MethodGet, "/v1/vault", nil, append(auth, "If-None-Match", `W/"1", "2"`)...)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("tag list get: %d", rec.Code)
	}
	rec = e.do(http.MethodGet, "/v1/vault", nil, append(auth, "If-None-Match", `"1"`)...)
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), envelope("two")) {
		t.Fatalf("stale conditional get: %d", rec.Code)
	}

	// History.
	rec = e.do(http.MethodGet, "/v1/vault/versions", nil, auth...)
	list := decodeBody[[]vaultVersionResponse](t, rec)
	if len(list) != 2 || list[0].Version != 2 || list[1].Version != 1 || list[1].DeviceName != "Test browser" ||
		list[1].Size != int64(len(envelope("one"))) {
		t.Fatalf("versions = %+v", list)
	}
	rec = e.do(http.MethodGet, "/v1/vault/versions/1", nil, auth...)
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), envelope("one")) {
		t.Fatalf("get version 1: %d", rec.Code)
	}
}

func TestPutVaultErrors(t *testing.T) {
	e := newTestEnv(t, func(c *config.Config) { c.MaxVaultBytes = 1024 })
	sess := e.register("alice", authKey(1))
	auth := bearer(sess.DeviceToken)
	if rec := e.do(http.MethodPut, "/v1/vault", envelope("v1"), append(auth, "If-None-Match", "*")...); rec.Code != http.StatusOK {
		t.Fatalf("setup put: %d", rec.Code)
	}

	t.Run("missing precondition", func(t *testing.T) {
		expectError(t, e.do(http.MethodPut, "/v1/vault", envelope("x"), auth...), http.StatusPreconditionRequired, codePreconditionRequired)
	})
	t.Run("both preconditions", func(t *testing.T) {
		expectError(t, e.do(http.MethodPut, "/v1/vault", envelope("x"), append(auth, "If-Match", `"1"`, "If-None-Match", "*")...),
			http.StatusBadRequest, codeInvalidRequest)
	})
	t.Run("malformed If-Match", func(t *testing.T) {
		expectError(t, e.do(http.MethodPut, "/v1/vault", envelope("x"), append(auth, "If-Match", "1")...), http.StatusBadRequest, codeInvalidRequest)
	})
	t.Run("stale If-Match", func(t *testing.T) {
		rec := e.do(http.MethodPut, "/v1/vault", envelope("x"), append(auth, "If-Match", `"7"`)...)
		if rec.Code != http.StatusPreconditionFailed || rec.Header().Get("ETag") != `"1"` {
			t.Fatalf("status %d etag %q", rec.Code, rec.Header().Get("ETag"))
		}
		got := decodeBody[conflictResponse](t, rec)
		if got.Error.Code != codeVersionConflict || got.Error.CurrentVersion != 1 {
			t.Fatalf("conflict body = %+v", got)
		}
	})
	t.Run("create when exists", func(t *testing.T) {
		rec := e.do(http.MethodPut, "/v1/vault", envelope("x"), append(auth, "If-None-Match", "*")...)
		if rec.Code != http.StatusPreconditionFailed || decodeBody[conflictResponse](t, rec).Error.CurrentVersion != 1 {
			t.Fatalf("status %d %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("too large", func(t *testing.T) {
		expectError(t, e.do(http.MethodPut, "/v1/vault", envelope(strings.Repeat("x", 2000)), append(auth, "If-Match", `"1"`)...),
			http.StatusRequestEntityTooLarge, codeVaultTooLarge)
	})
	t.Run("bad magic", func(t *testing.T) {
		bad := append([]byte("NOPE"), make([]byte, 40)...)
		expectError(t, e.do(http.MethodPut, "/v1/vault", bad, append(auth, "If-Match", `"1"`)...), http.StatusBadRequest, codeInvalidVault)
	})
	t.Run("too short", func(t *testing.T) {
		expectError(t, e.do(http.MethodPut, "/v1/vault", []byte("BSV1"), append(auth, "If-Match", `"1"`)...), http.StatusBadRequest, codeInvalidVault)
	})

	// None of the failed writes created a version.
	list := decodeBody[[]vaultVersionResponse](t, e.do(http.MethodGet, "/v1/vault/versions", nil, auth...))
	if len(list) != 1 {
		t.Fatalf("failed writes stored versions: %+v", list)
	}
}

func TestVaultVersionsArePerUser(t *testing.T) {
	e := newTestEnv(t)
	alice := e.register("alice", authKey(1))
	bob := e.register("bob", authKey(2))
	e.do(http.MethodPut, "/v1/vault", envelope("alice"), append(bearer(alice.DeviceToken), "If-None-Match", "*")...)

	expectError(t, e.do(http.MethodGet, "/v1/vault", nil, bearer(bob.DeviceToken)...), http.StatusNotFound, codeVaultEmpty)
	expectError(t, e.do(http.MethodGet, "/v1/vault/versions/1", nil, bearer(bob.DeviceToken)...), http.StatusNotFound, codeNotFound)
	expectError(t, e.do(http.MethodGet, "/v1/vault/versions/abc", nil, bearer(alice.DeviceToken)...), http.StatusNotFound, codeNotFound)
	expectError(t, e.do(http.MethodGet, "/v1/vault/versions/99", nil, bearer(alice.DeviceToken)...), http.StatusNotFound, codeNotFound)
}

func TestVaultRequiresDevice(t *testing.T) {
	e := newTestEnv(t)
	for _, ep := range []struct{ method, path string }{
		{http.MethodGet, "/v1/vault"},
		{http.MethodPut, "/v1/vault"},
		{http.MethodGet, "/v1/vault/versions"},
		{http.MethodGet, "/v1/vault/versions/1"},
	} {
		expectError(t, e.do(ep.method, ep.path, nil), http.StatusUnauthorized, codeUnauthorized)
	}
}

func TestParseETag(t *testing.T) {
	for in, want := range map[string]int64{`"1"`: 1, ` "42" `: 42} {
		if got, ok := parseETag(in); !ok || got != want {
			t.Errorf("parseETag(%q) = %d, %v", in, got, ok)
		}
	}
	for _, bad := range []string{`1`, `""`, `"0"`, `"-1"`, `"x"`, `W/"1"`, `"1`} {
		if _, ok := parseETag(bad); ok {
			t.Errorf("parseETag(%q) accepted", bad)
		}
	}
}

// TestPerUserVaultLimit: an account's own limit replaces the server default
// for uploads, rotations and the usage report; other accounts keep the default.
func TestPerUserVaultLimit(t *testing.T) {
	e := newTestEnv(t, func(c *config.Config) { c.MaxVaultBytes = 1024 })
	alice := bearer(e.register("alice", authKey(1)).DeviceToken)
	bob := bearer(e.register("bob", authKey(2)).DeviceToken)
	big := envelope(string(make([]byte, 1500))) // over the default, under alice's limit

	usage := func(auth []string) usageResponse {
		t.Helper()
		rec := e.do(http.MethodGet, "/v1/account/usage", nil, auth...)
		if rec.Code != http.StatusOK {
			t.Fatalf("usage: %d %s", rec.Code, rec.Body.String())
		}
		return decodeBody[usageResponse](t, rec)
	}
	if got := usage(alice); got != (usageResponse{VaultBytes: 0, MaxVaultBytes: 1024}) {
		t.Fatalf("empty vault usage = %+v", got)
	}

	expectError(t, e.do(http.MethodPut, "/v1/vault", big, append(alice, "If-None-Match", "*")...),
		http.StatusRequestEntityTooLarge, codeVaultTooLarge)

	if err := e.st.SetVaultLimit(context.Background(), "alice", 4096); err != nil {
		t.Fatal(err)
	}
	rec := e.do(http.MethodPut, "/v1/vault", big, append(alice, "If-None-Match", "*")...)
	if rec.Code != http.StatusOK {
		t.Fatalf("put under alice's own limit: %d %s", rec.Code, rec.Body.String())
	}
	if got := usage(alice); got != (usageResponse{VaultBytes: int64(len(big)), MaxVaultBytes: 4096}) {
		t.Fatalf("alice usage = %+v, want %d of 4096", got, len(big))
	}
	expectError(t, e.do(http.MethodPut, "/v1/vault", envelope(string(make([]byte, 5000))), append(alice, "If-Match", `"1"`)...),
		http.StatusRequestEntityTooLarge, codeVaultTooLarge)

	// bob still has the server default.
	expectError(t, e.do(http.MethodPut, "/v1/vault", big, append(bob, "If-None-Match", "*")...),
		http.StatusRequestEntityTooLarge, codeVaultTooLarge)
	if got := usage(bob); got.MaxVaultBytes != 1024 {
		t.Fatalf("bob limit = %d, want the default 1024", got.MaxVaultBytes)
	}

	// A limit below the default applies too.
	if err := e.st.SetVaultLimit(context.Background(), "bob", 100); err != nil {
		t.Fatal(err)
	}
	expectError(t, e.do(http.MethodPut, "/v1/vault", envelope(string(make([]byte, 200))), append(bob, "If-None-Match", "*")...),
		http.StatusRequestEntityTooLarge, codeVaultTooLarge)

	expectError(t, e.do(http.MethodGet, "/v1/account/usage", nil), http.StatusUnauthorized, codeUnauthorized)
}
