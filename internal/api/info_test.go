package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/config"
)

func decodeInfo(t *testing.T, e *testEnv) serverInfo {
	t.Helper()
	rec := e.do(http.MethodGet, "/v1/info", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %s", rec.Code, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q", ct)
	}
	var got serverInfo
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return got
}

func TestInfo(t *testing.T) {
	tests := []struct {
		name   string
		deps   func(*Deps)
		mutate func(*config.Config)
		want   serverInfo
	}{
		{
			name: "defaults",
			want: serverInfo{Service: "booksync", Protocol: 1, Version: "dev", Status: "ok", RegistrationOpen: true, MaxVaultBytes: 10 << 20},
		},
		{
			name: "version from deps",
			deps: func(d *Deps) { d.Version = "1.2.3" },
			want: serverInfo{Service: "booksync", Protocol: 1, Version: "1.2.3", Status: "ok", RegistrationOpen: true, MaxVaultBytes: 10 << 20},
		},
		{
			name:   "registration closed and smaller vaults",
			mutate: func(c *config.Config) { c.AllowRegistration = false; c.MaxVaultBytes = 4096 },
			want:   serverInfo{Service: "booksync", Protocol: 1, Version: "dev", Status: "ok", RegistrationOpen: false, MaxVaultBytes: 4096},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var mutate []func(*config.Config)
			if tt.mutate != nil {
				mutate = append(mutate, tt.mutate)
			}
			e := newTestEnvDeps(t, tt.deps, mutate...)
			if got := decodeInfo(t, e); got != tt.want {
				t.Fatalf("info = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestInfoStorageDown(t *testing.T) {
	e := newTestEnv(t)
	_ = e.st.Close()
	if got := decodeInfo(t, e); got.Status != "unavailable" {
		t.Fatalf("status = %q, want unavailable", got.Status)
	}
}

func TestInfoWrongMethodIsJSON405(t *testing.T) {
	e := newTestEnv(t)
	rec := e.do(http.MethodPost, "/v1/info", nil)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
	if got := decodeError(t, rec).Code; got != codeMethodNotAllowed {
		t.Fatalf("code = %q", got)
	}
}
