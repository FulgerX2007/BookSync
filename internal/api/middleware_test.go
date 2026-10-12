package api

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/FulgerX2007/BookSync/internal/auth"
)

func bearer(token string) []string { return []string{"Authorization", "Bearer " + token} }

func TestRequireDevice(t *testing.T) {
	unknown, _ := auth.NewDeviceToken()
	tests := []struct {
		name   string
		header func(valid string) []string
		setup  func(e *testEnv, valid string)
		status int
	}{
		{"no header", func(string) []string { return nil }, nil, http.StatusUnauthorized},
		{"basic scheme", func(v string) []string { return []string{"Authorization", "Basic " + v} }, nil, http.StatusUnauthorized},
		{"bearer without token", func(string) []string { return []string{"Authorization", "Bearer "} }, nil, http.StatusUnauthorized},
		{"malformed token", func(string) []string { return bearer("bst_short") }, nil, http.StatusUnauthorized},
		{"unknown token", func(string) []string { return bearer(unknown) }, nil, http.StatusUnauthorized},
		{"revoked token", bearer, func(e *testEnv, v string) {
			if rec := e.do(http.MethodPost, "/v1/auth/logout", nil, bearer(v)...); rec.Code != http.StatusNoContent {
				e.t.Fatalf("logout: %d", rec.Code)
			}
		}, http.StatusUnauthorized},
		{"expired token", bearer, func(e *testEnv, _ string) { e.now = e.now.Add(e.cfg.TokenTTL) }, http.StatusUnauthorized},
		{"valid token", bearer, nil, http.StatusOK},
		{"lowercase scheme", func(v string) []string { return []string{"Authorization", "bearer " + v} }, nil, http.StatusOK},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newTestEnv(t)
			sess := e.register("alice", authKey(1))
			if tt.setup != nil {
				tt.setup(e, sess.DeviceToken)
			}
			rec := e.do(http.MethodGet, "/v1/devices", nil, tt.header(sess.DeviceToken)...)
			if rec.Code != tt.status {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tt.status, rec.Body.String())
			}
			if tt.status == http.StatusUnauthorized {
				expectError(t, rec, http.StatusUnauthorized, codeUnauthorized)
				if !strings.HasPrefix(rec.Header().Get("WWW-Authenticate"), "Bearer") {
					t.Fatal("missing WWW-Authenticate header")
				}
			}
		})
	}
}

func TestRequireDeviceSlidesExpiry(t *testing.T) {
	e := newTestEnv(t)
	sess := e.register("alice", authKey(1))
	hash, _ := auth.HashToken(sess.DeviceToken)

	// Within the touch interval nothing is written.
	e.now = e.now.Add(30 * time.Minute)
	e.do(http.MethodGet, "/v1/devices", nil, bearer(sess.DeviceToken)...)
	d, err := e.st.DeviceByTokenHash(context.Background(), hash)
	if err != nil {
		t.Fatal(err)
	}
	if !d.LastSeenAt.Equal(testNow) {
		t.Fatalf("touched too early: last seen %v", d.LastSeenAt)
	}

	// After the interval the expiry slides forward.
	e.now = testNow.Add(2 * time.Hour)
	e.do(http.MethodGet, "/v1/devices", nil, bearer(sess.DeviceToken)...)
	d, err = e.st.DeviceByTokenHash(context.Background(), hash)
	if err != nil {
		t.Fatal(err)
	}
	if !d.LastSeenAt.Equal(e.now) || !d.ExpiresAt.Equal(e.now.Add(e.cfg.TokenTTL)) {
		t.Fatalf("expiry not slid: %+v", d)
	}

	// A token used regularly outlives its original TTL.
	e.now = testNow.Add(e.cfg.TokenTTL + time.Hour)
	if rec := e.do(http.MethodGet, "/v1/devices", nil, bearer(sess.DeviceToken)...); rec.Code != http.StatusOK {
		t.Fatalf("token expired despite activity: %d", rec.Code)
	}
}
