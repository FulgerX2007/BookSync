package api

import (
	"context"
	"errors"
	"net/http"
	"testing"

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
