package api

import (
	"bytes"
	"net/http"
	"strings"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/config"
)

func TestRegisterThenLogin(t *testing.T) {
	e := newTestEnv(t)
	reg := e.register("alice", authKey(1))
	if reg.UserID == "" || reg.DeviceID == "" || !strings.HasPrefix(reg.DeviceToken, "bst_") {
		t.Fatalf("unexpected register response %+v", reg)
	}
	if reg.WrappedVaultKey != nil || reg.KDF != "" {
		t.Fatalf("register must not echo credentials: %+v", reg)
	}

	login := e.login("ALICE ", authKey(1), "Second browser")
	if login.UserID != reg.UserID {
		t.Fatalf("login user %q != registered %q", login.UserID, reg.UserID)
	}
	if login.DeviceID == reg.DeviceID || login.DeviceToken == reg.DeviceToken {
		t.Fatal("login must create a new device and token")
	}
	if !bytes.Equal(login.WrappedVaultKey, []byte("wrapped-alice")) {
		t.Fatalf("wrappedVaultKey = %q", login.WrappedVaultKey)
	}
	if login.KDF != kdfPBKDF2 || login.Iterations != minKDFIterations {
		t.Fatalf("kdf params = %s/%d", login.KDF, login.Iterations)
	}
}

func TestPreloginDoesNotRevealAccounts(t *testing.T) {
	e := newTestEnv(t)
	body := registerBody("bob", authKey(2))
	body["iterations"] = 700_000
	if rec := e.do(http.MethodPost, "/v1/auth/register", body); rec.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
	}

	known := e.do(http.MethodGet, "/v1/auth/prelogin?username=Bob", nil)
	if got := decodeBody[kdfParams](t, known); got.Iterations != 700_000 || got.KDF != kdfPBKDF2 {
		t.Fatalf("known user params = %+v", got)
	}
	for _, q := range []string{"username=nobody", "username=!!", ""} {
		rec := e.do(http.MethodGet, "/v1/auth/prelogin?"+q, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", q, rec.Code)
		}
		got := decodeBody[map[string]any](t, rec)
		if len(got) != 2 || got["kdf"] != kdfPBKDF2 || got["iterations"] != float64(minKDFIterations) {
			t.Fatalf("%s: response %v differs in shape or defaults", q, got)
		}
	}
}

func TestRegisterValidation(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"short username", func(b map[string]any) { b["username"] = "ab" }},
		{"bad username chars", func(b map[string]any) { b["username"] = "bad name" }},
		{"short auth key", func(b map[string]any) { b["authKey"] = b64("short") }},
		{"auth key not base64url", func(b map[string]any) { b["authKey"] = "not base64!" }},
		{"wrong kdf", func(b map[string]any) { b["kdf"] = "md5" }},
		{"low iterations", func(b map[string]any) { b["iterations"] = 1000 }},
		{"empty wrapped key", func(b map[string]any) { b["wrappedVaultKey"] = b64{} }},
		{"oversized wrapped key", func(b map[string]any) { b["wrappedVaultKey"] = b64(make([]byte, maxWrappedKeySize+1)) }},
		{"empty device name", func(b map[string]any) { b["deviceName"] = " " }},
		{"control chars in device name", func(b map[string]any) { b["deviceName"] = "a\x00b" }},
		{"unknown field", func(b map[string]any) { b["admin"] = true }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newTestEnv(t)
			body := registerBody("carol", authKey(3))
			tt.mutate(body)
			expectError(t, e.do(http.MethodPost, "/v1/auth/register", body), http.StatusBadRequest, codeInvalidRequest)
		})
	}
	t.Run("malformed json", func(t *testing.T) {
		e := newTestEnv(t)
		expectError(t, e.do(http.MethodPost, "/v1/auth/register", `{"username":`), http.StatusBadRequest, codeInvalidRequest)
	})
}

func TestRegisterDuplicateUsername(t *testing.T) {
	e := newTestEnv(t)
	e.register("dave", authKey(4))
	expectError(t, e.do(http.MethodPost, "/v1/auth/register", registerBody("Dave", authKey(5))), http.StatusConflict, codeUsernameTaken)
}

func TestRegistrationClosed(t *testing.T) {
	e := newTestEnv(t, func(c *config.Config) { c.AllowRegistration = false })
	expectError(t, e.do(http.MethodPost, "/v1/auth/register", registerBody("erin", authKey(6))), http.StatusForbidden, codeRegistrationClosed)
}

func TestLoginFailuresAreIndistinguishable(t *testing.T) {
	e := newTestEnv(t)
	e.register("frank", authKey(7))
	var bodies []string
	for _, tc := range []struct{ user string }{{"frank"}, {"nobody"}, {"!!"}} {
		key := authKey(8) // wrong for frank
		rec := e.do(http.MethodPost, "/v1/auth/login", map[string]any{"username": tc.user, "authKey": key, "deviceName": "x"})
		expectError(t, rec, http.StatusUnauthorized, codeInvalidCredentials)
		bodies = append(bodies, rec.Body.String())
	}
	for _, b := range bodies[1:] {
		if b != bodies[0] {
			t.Fatalf("login error bodies differ: %q vs %q", bodies[0], b)
		}
	}
}

func TestLoginValidation(t *testing.T) {
	e := newTestEnv(t)
	e.register("gina", authKey(9))
	expectError(t, e.do(http.MethodPost, "/v1/auth/login",
		map[string]any{"username": "gina", "authKey": authKey(9), "deviceName": ""}), http.StatusBadRequest, codeInvalidRequest)
	expectError(t, e.do(http.MethodPost, "/v1/auth/login",
		map[string]any{"username": "gina", "authKey": b64("short"), "deviceName": "x"}), http.StatusBadRequest, codeInvalidRequest)
}
