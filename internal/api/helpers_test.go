package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/FulgerX2007/BookSync/internal/auth"
	"github.com/FulgerX2007/BookSync/internal/config"
	"github.com/FulgerX2007/BookSync/internal/store"
)

func discardLogger() *slog.Logger { return slog.New(slog.DiscardHandler) }

var testNow = time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)

// testEnv is a full API stack over a real SQLite database with a controllable clock.
type testEnv struct {
	t   *testing.T
	cfg config.Config
	st  *store.Store
	h   http.Handler
	now time.Time
}

func newTestEnv(t *testing.T, mutate ...func(*config.Config)) *testEnv {
	t.Helper()
	cfg := config.Default()
	for _, m := range mutate {
		m(&cfg)
	}
	e := &testEnv{t: t, cfg: cfg, now: testNow}
	clock := func() time.Time { return e.now }
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "api.db"), store.WithClock(clock))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	e.st = st
	e.h = NewServer(cfg, Deps{Logger: discardLogger(), Store: st, Hasher: auth.NewTestHasher(), Now: clock})
	return e
}

// do sends a request. body may be nil, string, []byte or a value to JSON-encode.
// hdr is a list of header name/value pairs.
func (e *testEnv) do(method, path string, body any, hdr ...string) *httptest.ResponseRecorder {
	e.t.Helper()
	var rdr io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		rdr = strings.NewReader(b)
	case []byte:
		rdr = bytes.NewReader(b)
	default:
		enc, err := json.Marshal(b)
		if err != nil {
			e.t.Fatalf("marshal body: %v", err)
		}
		rdr = bytes.NewReader(enc)
	}
	req := httptest.NewRequest(method, path, rdr)
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

func authKey(b byte) b64 { return bytes.Repeat([]byte{b}, auth.AuthKeySize) }

func registerBody(username string, key b64) map[string]any {
	return map[string]any{
		"username":        username,
		"authKey":         key,
		"kdf":             kdfPBKDF2,
		"iterations":      minKDFIterations,
		"wrappedVaultKey": b64("wrapped-" + username),
		"deviceName":      "Test browser",
	}
}

// register creates an account and returns its first device session.
func (e *testEnv) register(username string, key b64) sessionResponse {
	e.t.Helper()
	rec := e.do(http.MethodPost, "/v1/auth/register", registerBody(username, key))
	if rec.Code != http.StatusCreated {
		e.t.Fatalf("register %s: %d %s", username, rec.Code, rec.Body.String())
	}
	return decodeBody[sessionResponse](e.t, rec)
}

// login signs in an additional device.
func (e *testEnv) login(username string, key b64, deviceName string) sessionResponse {
	e.t.Helper()
	rec := e.do(http.MethodPost, "/v1/auth/login", map[string]any{"username": username, "authKey": key, "deviceName": deviceName})
	if rec.Code != http.StatusOK {
		e.t.Fatalf("login %s: %d %s", username, rec.Code, rec.Body.String())
	}
	return decodeBody[sessionResponse](e.t, rec)
}

func decodeBody[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return v
}

func expectError(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, status, rec.Body.String())
	}
	if got := decodeBody[errorResponse](t, rec).Error.Code; got != code {
		t.Fatalf("error code = %q, want %q", got, code)
	}
}
