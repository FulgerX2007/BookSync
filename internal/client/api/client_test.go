package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/FulgerX2007/BookSync/internal/client/crypto"
	"github.com/FulgerX2007/BookSync/internal/client/testserver"
	"github.com/FulgerX2007/BookSync/internal/config"
)

var ctx = context.Background()

func randomBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

func newClient(t *testing.T, url string) *Client {
	t.Helper()
	c, err := New(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

var kdf = KDFParams{KDF: crypto.KDFName, Iterations: crypto.MinIterations}

func register(t *testing.T, c *Client, username string, authKey []byte) Session {
	t.Helper()
	s, err := c.Register(ctx, RegisterRequest{Username: username, AuthKey: authKey, KDF: kdf, WrappedVaultKey: randomBytes(60), DeviceName: "first"})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	return s
}

func envelope() []byte { return append([]byte("BSV1"), randomBytes(40)...) }

func TestVaultFlowAgainstRealServer(t *testing.T) {
	srv := testserver.Start(t)
	c := newClient(t, srv.URL)
	authKey := randomBytes(32)
	s := register(t, c, "alice", authKey)
	c.SetToken(s.DeviceToken)

	if p, err := c.Prelogin(ctx, "alice"); err != nil || p != kdf {
		t.Fatalf("Prelogin = %+v, %v", p, err)
	}
	if got, err := c.GetVault(ctx, 0); err != nil || got.Status != VaultEmpty {
		t.Fatalf("GetVault on a new account = %+v, %v", got, err)
	}

	first := envelope()
	put, err := c.PutVault(ctx, first, 0)
	if err != nil || put.Conflict || put.Version != 1 {
		t.Fatalf("first PutVault = %+v, %v", put, err)
	}
	got, err := c.GetVault(ctx, 0)
	if err != nil || got.Status != VaultOK || got.Version != 1 || !bytes.Equal(got.Body, first) {
		t.Fatalf("GetVault = %+v, %v", got.Status, err)
	}
	if got, err := c.GetVault(ctx, 1); err != nil || got.Status != VaultNotModified {
		t.Fatalf("GetVault(1) = %+v, %v", got.Status, err)
	}

	// Creating again, or writing against a stale version, is a conflict.
	if res, err := c.PutVault(ctx, envelope(), 0); err != nil || !res.Conflict || res.CurrentVersion != 1 {
		t.Fatalf("second create = %+v, %v", res, err)
	}
	if res, err := c.PutVault(ctx, envelope(), 1); err != nil || res.Version != 2 {
		t.Fatalf("update = %+v, %v", res, err)
	}
	if res, err := c.PutVault(ctx, envelope(), 1); err != nil || !res.Conflict || res.CurrentVersion != 2 {
		t.Fatalf("stale update = %+v, %v", res, err)
	}

	// A second device logs in and receives the wrapped key.
	other := newClient(t, srv.URL)
	ls, err := other.Login(ctx, "alice", authKey, "second")
	if err != nil || ls.DeviceToken == "" || len(ls.WrappedVaultKey) != 60 || ls.KDFParams != kdf {
		t.Fatalf("Login = %+v, %v", ls, err)
	}

	if err := c.Logout(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetVault(ctx, 0); CodeOf(err) != CodeUnauthorized {
		t.Fatalf("after logout err = %v, want unauthorized", err)
	}
}

func TestAuthErrorsAgainstRealServer(t *testing.T) {
	srv := testserver.Start(t)
	c := newClient(t, srv.URL)
	register(t, c, "alice", randomBytes(32))

	if _, err := c.Login(ctx, "alice", randomBytes(32), "x"); CodeOf(err) != CodeInvalidCredentials {
		t.Errorf("wrong key: %v", err)
	}
	_, err := c.Register(ctx, RegisterRequest{Username: "alice", AuthKey: randomBytes(32), KDF: kdf, WrappedVaultKey: randomBytes(60), DeviceName: "x"})
	if CodeOf(err) != CodeUsernameTaken {
		t.Errorf("duplicate username: %v", err)
	}
	_, err = c.Register(ctx, RegisterRequest{Username: "bob", AuthKey: randomBytes(5), KDF: kdf, WrappedVaultKey: randomBytes(60), DeviceName: "x"})
	if CodeOf(err) != CodeInvalidRequest {
		t.Errorf("short auth key: %v", err)
	}
	if _, err := c.GetVault(ctx, 0); CodeOf(err) != CodeUnauthorized {
		t.Errorf("no token: %v", err)
	}
	c.SetToken("bst_bogus")
	if err := c.Logout(ctx); CodeOf(err) != CodeUnauthorized {
		t.Errorf("bad token: %v", err)
	}

	closed := testserver.Start(t, func(cfg *config.Config) { cfg.AllowRegistration = false })
	_, err = newClient(t, closed.URL).Register(ctx, RegisterRequest{Username: "carol", AuthKey: randomBytes(32), KDF: kdf, WrappedVaultKey: randomBytes(60), DeviceName: "x"})
	if CodeOf(err) != CodeRegistrationClosed {
		t.Errorf("closed registration: %v", err)
	}
}

func TestRateLimitedCarriesRetryAfter(t *testing.T) {
	srv := testserver.Start(t)
	c := newClient(t, srv.URL)
	var err error
	for range 30 {
		if _, err = c.Prelogin(ctx, "someone"); err != nil {
			break
		}
	}
	var e *Error
	if !errors.As(err, &e) || e.Code != CodeRateLimited || e.RetryAfter <= 0 || e.Status != http.StatusTooManyRequests {
		t.Fatalf("err = %#v, want rate_limited with Retry-After", err)
	}
}

// A malicious server cannot weaken key derivation.
func TestRefusesDowngradedKDF(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/auth/prelogin":
			_, _ = w.Write([]byte(`{"kdf":"pbkdf2-sha256","iterations":1000}`))
		case "/v1/auth/login":
			_, _ = w.Write([]byte(`{"userId":"u","deviceId":"d","deviceToken":"t","wrappedVaultKey":"AAAA","kdf":"md5","iterations":600000}`))
		}
	}))
	defer srv.Close()
	c := newClient(t, srv.URL)
	if _, err := c.Prelogin(ctx, "alice"); crypto.CodeOf(err) != crypto.CodeWeakKDF {
		t.Errorf("prelogin: %v", err)
	}
	if _, err := c.Login(ctx, "alice", randomBytes(32), "x"); crypto.CodeOf(err) != crypto.CodeWeakKDF {
		t.Errorf("login: %v", err)
	}
}

func TestMalformedResponses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/vault":
			if r.Method == http.MethodGet {
				_, _ = w.Write([]byte("no etag"))
				return
			}
			_, _ = w.Write([]byte("not json"))
		case "/v1/auth/login":
			_, _ = w.Write([]byte(`{"wrappedVaultKey":"!!","kdf":"pbkdf2-sha256","iterations":600000}`))
		case "/teapot":
			w.WriteHeader(http.StatusTeapot)
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"nope"}}`))
		}
	}))
	defer srv.Close()
	c := newClient(t, srv.URL)
	c.SetToken("t")
	if _, err := c.GetVault(ctx, 0); CodeOf(err) != CodeServer {
		t.Errorf("missing ETag: %v", err)
	}
	if _, err := c.PutVault(ctx, envelope(), 3); CodeOf(err) != CodeServer {
		t.Errorf("bad PUT body: %v", err)
	}
	if _, err := c.Login(ctx, "a", randomBytes(32), "x"); CodeOf(err) != CodeServer {
		t.Errorf("bad wrapped key: %v", err)
	}
	if _, err := c.Prelogin(ctx, "a"); CodeOf(err) != CodeNotFound {
		t.Errorf("404: %v", err)
	}
	resp, err := c.send(ctx, http.MethodGet, "/teapot", nil, nil, false)
	if err == nil {
		drain(resp)
	}
	if CodeOf(err) != CodeServer {
		t.Errorf("418: %v", err)
	}
}

func TestNetworkError(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	c, _ := New(url, &http.Client{Timeout: time.Second})
	if _, err := c.Prelogin(ctx, "a"); CodeOf(err) != CodeNetwork {
		t.Fatalf("err = %v", err)
	}
}

func TestNormalizeServerURL(t *testing.T) {
	tests := []struct {
		in, want string
		ok       bool
	}{
		{"https://Sync.Example.com/", "https://sync.example.com", true},
		{" https://sync.example.com/booksync// ", "https://sync.example.com/booksync", true},
		{"https://sync.example.com:8443/x", "https://sync.example.com:8443/x", true},
		{"http://localhost:8080", "http://localhost:8080", true},
		{"http://127.0.0.1:8080/", "http://127.0.0.1:8080", true},
		{"http://[::1]:8080", "http://[::1]:8080", true},
		{"http://sync.example.com", "", false},
		{"ftp://sync.example.com", "", false},
		{"https://user:pw@sync.example.com", "", false},
		{"https://sync.example.com/?q=1", "", false},
		{"https://sync.example.com/#x", "", false},
		{"sync.example.com", "", false},
		{"", "", false},
		{"https://", "", false},
	}
	for _, tt := range tests {
		got, err := NormalizeServerURL(tt.in)
		if tt.ok != (err == nil) || got != tt.want {
			t.Errorf("NormalizeServerURL(%q) = %q, %v; want %q", tt.in, got, err, tt.want)
		}
		if err != nil && CodeOf(err) != CodeInsecureURL {
			t.Errorf("%q: code %q", tt.in, CodeOf(err))
		}
	}
	if _, err := New("http://example.com", nil); CodeOf(err) != CodeInsecureURL {
		t.Error("New accepted plain http")
	}
	c := newClient(t, "https://x.example/")
	if c.BaseURL() != "https://x.example" || !strings.HasPrefix((&Error{Message: "m"}).Error(), "api: ") {
		t.Error("BaseURL / Error()")
	}
}

func TestParseETag(t *testing.T) {
	for in, want := range map[string]int64{`"1"`: 1, `"42"`: 42} {
		if got, ok := parseETag(in); !ok || got != want {
			t.Errorf("parseETag(%s) = %d, %v", in, got, ok)
		}
	}
	for _, bad := range []string{``, `1`, `""`, `"-1"`, `W/"1"`, `"1a"`} {
		if _, ok := parseETag(bad); ok {
			t.Errorf("parseETag(%s) accepted", bad)
		}
	}
}

func TestDeleteAccountAgainstRealServer(t *testing.T) {
	srv := testserver.Start(t)
	c := newClient(t, srv.URL)
	authKey := randomBytes(32)
	s := register(t, c, "alice", authKey)
	c.SetToken(s.DeviceToken)
	if err := c.DeleteAccount(ctx, randomBytes(32)); CodeOf(err) != CodeInvalidCredentials {
		t.Fatalf("wrong key: %v", err)
	}
	if err := c.DeleteAccount(ctx, authKey); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetVault(ctx, 0); CodeOf(err) != CodeUnauthorized {
		t.Fatalf("token still valid: %v", err)
	}
}
