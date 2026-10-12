package api

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/config"
	"github.com/FulgerX2007/BookSync/internal/store"
)

func TestListDevicesMarksCurrent(t *testing.T) {
	e := newTestEnv(t)
	first := e.register("alice", authKey(1))
	second := e.login("alice", authKey(1), "Firefox")

	rec := e.do(http.MethodGet, "/v1/devices", nil, bearer(second.DeviceToken)...)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	list := decodeBody[[]deviceResponse](t, rec)
	if len(list) != 2 {
		t.Fatalf("got %d devices, want 2", len(list))
	}
	for _, d := range list {
		wantCurrent := d.ID == second.DeviceID
		if d.Current != wantCurrent {
			t.Fatalf("device %s current=%v, want %v", d.ID, d.Current, wantCurrent)
		}
		if d.ID == first.DeviceID && d.Name != "Test browser" {
			t.Fatalf("first device name = %q", d.Name)
		}
	}
}

func TestRevokeDevice(t *testing.T) {
	e := newTestEnv(t)
	first := e.register("alice", authKey(1))
	second := e.login("alice", authKey(1), "Firefox")

	if rec := e.do(http.MethodDelete, "/v1/devices/"+second.DeviceID, nil, bearer(first.DeviceToken)...); rec.Code != http.StatusNoContent {
		t.Fatalf("revoke: %d %s", rec.Code, rec.Body.String())
	}
	expectError(t, e.do(http.MethodGet, "/v1/devices", nil, bearer(second.DeviceToken)...), http.StatusUnauthorized, codeUnauthorized)
	expectError(t, e.do(http.MethodDelete, "/v1/devices/"+second.DeviceID, nil, bearer(first.DeviceToken)...), http.StatusNotFound, codeNotFound)
}

func TestRevokeOtherUsersDeviceIs404(t *testing.T) {
	e := newTestEnv(t)
	alice := e.register("alice", authKey(1))
	bob := e.register("bob", authKey(2))

	expectError(t, e.do(http.MethodDelete, "/v1/devices/"+bob.DeviceID, nil, bearer(alice.DeviceToken)...), http.StatusNotFound, codeNotFound)
	if rec := e.do(http.MethodGet, "/v1/devices", nil, bearer(bob.DeviceToken)...); rec.Code != http.StatusOK {
		t.Fatalf("bob's device was revoked by alice: %d", rec.Code)
	}
}

func TestLogoutRevokesOnlyCurrentDevice(t *testing.T) {
	e := newTestEnv(t)
	first := e.register("alice", authKey(1))
	second := e.login("alice", authKey(1), "Firefox")

	if rec := e.do(http.MethodPost, "/v1/auth/logout", nil, bearer(second.DeviceToken)...); rec.Code != http.StatusNoContent {
		t.Fatalf("logout: %d", rec.Code)
	}
	expectError(t, e.do(http.MethodGet, "/v1/devices", nil, bearer(second.DeviceToken)...), http.StatusUnauthorized, codeUnauthorized)
	if rec := e.do(http.MethodGet, "/v1/devices", nil, bearer(first.DeviceToken)...); rec.Code != http.StatusOK {
		t.Fatalf("other device logged out too: %d", rec.Code)
	}
}

func TestDeleteAccount(t *testing.T) {
	e := newTestEnv(t)
	alice := e.register("alice", authKey(1))
	e.login("alice", authKey(1), "Firefox")
	bob := e.register("bob", authKey(2))

	expectError(t, e.do(http.MethodPost, "/v1/account/delete", map[string]any{"authKey": authKey(9)}, bearer(alice.DeviceToken)...),
		http.StatusUnauthorized, codeInvalidCredentials)

	if rec := e.do(http.MethodPost, "/v1/account/delete", map[string]any{"authKey": authKey(1)}, bearer(alice.DeviceToken)...); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := e.st.UserByID(context.Background(), alice.UserID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("user still present: %v", err)
	}
	devices, err := e.st.ListDevices(context.Background(), alice.UserID)
	if err != nil || len(devices) != 0 {
		t.Fatalf("devices left: %v, %v", devices, err)
	}
	expectError(t, e.do(http.MethodGet, "/v1/devices", nil, bearer(alice.DeviceToken)...), http.StatusUnauthorized, codeUnauthorized)
	expectError(t, e.do(http.MethodPost, "/v1/auth/login", map[string]any{"username": "alice", "authKey": authKey(1), "deviceName": "x"}),
		http.StatusUnauthorized, codeInvalidCredentials)

	if rec := e.do(http.MethodGet, "/v1/devices", nil, bearer(bob.DeviceToken)...); rec.Code != http.StatusOK {
		t.Fatalf("other account affected: %d", rec.Code)
	}
}

func TestProtectedEndpointsRequireToken(t *testing.T) {
	e := newTestEnv(t)
	for _, ep := range []struct{ method, path string }{
		{http.MethodPost, "/v1/auth/logout"},
		{http.MethodGet, "/v1/devices"},
		{http.MethodDelete, "/v1/devices/x"},
		{http.MethodPost, "/v1/account/delete"},
	} {
		expectError(t, e.do(ep.method, ep.path, nil), http.StatusUnauthorized, codeUnauthorized)
	}
}

func changeBody(current, next b64) map[string]any {
	return map[string]any{
		"currentAuthKey":     current,
		"newAuthKey":         next,
		"kdf":                kdfPBKDF2,
		"iterations":         minKDFIterations,
		"newWrappedVaultKey": b64("rewrapped"),
	}
}

func TestChangePassword(t *testing.T) {
	e := newTestEnv(t)
	first := e.register("alice", authKey(1))
	second := e.login("alice", authKey(1), "Firefox")
	e.do(http.MethodPut, "/v1/vault", envelope("v1"), append(bearer(first.DeviceToken), "If-None-Match", "*")...)

	rec := e.do(http.MethodPost, "/v1/account/password", changeBody(authKey(1), authKey(2)), bearer(first.DeviceToken)...)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("change: %d %s", rec.Code, rec.Body.String())
	}

	// Old key no longer logs in; the new one does and returns the re-wrapped key.
	expectError(t, e.do(http.MethodPost, "/v1/auth/login", map[string]any{"username": "alice", "authKey": authKey(1), "deviceName": "x"}),
		http.StatusUnauthorized, codeInvalidCredentials)
	if got := e.login("alice", authKey(2), "x"); string(got.WrappedVaultKey) != "rewrapped" {
		t.Fatalf("wrapped key = %q", got.WrappedVaultKey)
	}
	// Other devices are signed out, this one stays signed in, history is kept.
	expectError(t, e.do(http.MethodGet, "/v1/devices", nil, bearer(second.DeviceToken)...), http.StatusUnauthorized, codeUnauthorized)
	list := decodeBody[[]vaultVersionResponse](t, e.do(http.MethodGet, "/v1/vault/versions", nil, bearer(first.DeviceToken)...))
	if len(list) != 1 {
		t.Fatalf("history = %+v", list)
	}
}

func TestChangePasswordWithRotation(t *testing.T) {
	e := newTestEnv(t)
	first := e.register("alice", authKey(1))
	auth := bearer(first.DeviceToken)
	e.do(http.MethodPut, "/v1/vault", envelope("v1"), append(auth, "If-None-Match", "*")...)
	e.do(http.MethodPut, "/v1/vault", envelope("v2"), append(auth, "If-Match", `"1"`)...)

	body := changeBody(authKey(1), authKey(2))
	body["rotation"] = map[string]any{"expectedVersion": 2, "vault": b64(envelope("rotated"))}
	rec := e.do(http.MethodPost, "/v1/account/password", body, auth...)
	if rec.Code != http.StatusOK || rec.Header().Get("ETag") != `"3"` || decodeBody[putVaultResponse](t, rec).Version != 3 {
		t.Fatalf("rotate: %d %s", rec.Code, rec.Body.String())
	}
	list := decodeBody[[]vaultVersionResponse](t, e.do(http.MethodGet, "/v1/vault/versions", nil, auth...))
	if len(list) != 1 || list[0].Version != 3 {
		t.Fatalf("history after rotation = %+v", list)
	}
	got := e.do(http.MethodGet, "/v1/vault", nil, auth...)
	if !bytes.Equal(got.Body.Bytes(), envelope("rotated")) {
		t.Fatal("current vault is not the rotated one")
	}
}

func TestChangePasswordErrors(t *testing.T) {
	e := newTestEnv(t, func(c *config.Config) { c.MaxVaultBytes = 1024 })
	sess := e.register("alice", authKey(1))
	auth := bearer(sess.DeviceToken)
	e.do(http.MethodPut, "/v1/vault", envelope("v1"), append(auth, "If-None-Match", "*")...)

	withRotation := func(expected int, vault []byte) map[string]any {
		b := changeBody(authKey(1), authKey(2))
		b["rotation"] = map[string]any{"expectedVersion": expected, "vault": b64(vault)}
		return b
	}
	tests := []struct {
		name   string
		body   map[string]any
		status int
		code   string
	}{
		{"wrong current key", changeBody(authKey(9), authKey(2)), http.StatusUnauthorized, codeInvalidCredentials},
		{"short new key", changeBody(authKey(1), b64("short")), http.StatusBadRequest, codeInvalidRequest},
		{"low iterations", func() map[string]any { b := changeBody(authKey(1), authKey(2)); b["iterations"] = 5; return b }(),
			http.StatusBadRequest, codeInvalidRequest},
		{"missing wrapped key", func() map[string]any {
			b := changeBody(authKey(1), authKey(2))
			delete(b, "newWrappedVaultKey")
			return b
		}(),
			http.StatusBadRequest, codeInvalidRequest},
		{"stale rotation", withRotation(0, envelope("r")), http.StatusPreconditionFailed, codeVersionConflict},
		{"bad rotation envelope", withRotation(1, []byte("garbage-garbage-garbage-garbage-garbage")), http.StatusBadRequest, codeInvalidVault},
		{"oversized rotation", withRotation(1, envelope(string(make([]byte, 2000)))), http.StatusRequestEntityTooLarge, codeVaultTooLarge},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			expectError(t, e.do(http.MethodPost, "/v1/account/password", tt.body, auth...), tt.status, tt.code)
		})
	}
	// Nothing above changed the credentials.
	e.login("alice", authKey(1), "still works")
}
