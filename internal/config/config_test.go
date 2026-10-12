package config

import (
	"log/slog"
	"strings"
	"testing"
	"time"
)

func env(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(env(nil))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg != Default() {
		t.Fatalf("got %+v, want defaults %+v", cfg, Default())
	}
}

func TestLoadOverrides(t *testing.T) {
	tests := []struct {
		name  string
		vars  map[string]string
		check func(Config) bool
	}{
		{"addr", map[string]string{"BOOKSYNC_ADDR": "127.0.0.1:9000"}, func(c Config) bool { return c.Addr == "127.0.0.1:9000" }},
		{"db path", map[string]string{"BOOKSYNC_DB_PATH": "/tmp/x.db"}, func(c Config) bool { return c.DBPath == "/tmp/x.db" }},
		{"registration off", map[string]string{"BOOKSYNC_ALLOW_REGISTRATION": "false"}, func(c Config) bool { return !c.AllowRegistration }},
		{"max vault", map[string]string{"BOOKSYNC_MAX_VAULT_BYTES": "2048"}, func(c Config) bool { return c.MaxVaultBytes == 2048 }},
		{"keep recent", map[string]string{"BOOKSYNC_VAULT_KEEP_RECENT": "3"}, func(c Config) bool { return c.VaultKeepRecent == 3 }},
		{"keep days zero", map[string]string{"BOOKSYNC_VAULT_KEEP_DAYS": "0"}, func(c Config) bool { return c.VaultKeepDays == 0 }},
		{"token ttl", map[string]string{"BOOKSYNC_TOKEN_TTL": "24h"}, func(c Config) bool { return c.TokenTTL == 24*time.Hour }},
		{"trust proxy", map[string]string{"BOOKSYNC_TRUST_PROXY_HEADERS": "true"}, func(c Config) bool { return c.TrustProxyHeaders }},
		{"log level", map[string]string{"BOOKSYNC_LOG_LEVEL": "debug"}, func(c Config) bool { return c.LogLevel == slog.LevelDebug }},
		{"whitespace trimmed", map[string]string{"BOOKSYNC_ADDR": "  :9 "}, func(c Config) bool { return c.Addr == ":9" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := Load(env(tt.vars))
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if !tt.check(cfg) {
				t.Fatalf("override not applied: %+v", cfg)
			}
		})
	}
}

func TestLoadInvalid(t *testing.T) {
	tests := []struct {
		name    string
		vars    map[string]string
		wantKey string
	}{
		{"bad bool", map[string]string{"BOOKSYNC_ALLOW_REGISTRATION": "maybe"}, "BOOKSYNC_ALLOW_REGISTRATION"},
		{"non-numeric size", map[string]string{"BOOKSYNC_MAX_VAULT_BYTES": "10MB"}, "BOOKSYNC_MAX_VAULT_BYTES"},
		{"size too small", map[string]string{"BOOKSYNC_MAX_VAULT_BYTES": "100"}, "BOOKSYNC_MAX_VAULT_BYTES"},
		{"keep recent zero", map[string]string{"BOOKSYNC_VAULT_KEEP_RECENT": "0"}, "BOOKSYNC_VAULT_KEEP_RECENT"},
		{"keep days negative", map[string]string{"BOOKSYNC_VAULT_KEEP_DAYS": "-1"}, "BOOKSYNC_VAULT_KEEP_DAYS"},
		{"bad duration", map[string]string{"BOOKSYNC_TOKEN_TTL": "90 days"}, "BOOKSYNC_TOKEN_TTL"},
		{"ttl too short", map[string]string{"BOOKSYNC_TOKEN_TTL": "5m"}, "BOOKSYNC_TOKEN_TTL"},
		{"bad level", map[string]string{"BOOKSYNC_LOG_LEVEL": "loud"}, "BOOKSYNC_LOG_LEVEL"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Load(env(tt.vars))
			if err == nil {
				t.Fatal("expected error")
			}
			if !strings.Contains(err.Error(), tt.wantKey) {
				t.Fatalf("error %q does not mention %s", err, tt.wantKey)
			}
		})
	}
}

func TestLoadReportsAllErrors(t *testing.T) {
	_, err := Load(env(map[string]string{
		"BOOKSYNC_VAULT_KEEP_RECENT": "x",
		"BOOKSYNC_TOKEN_TTL":         "y",
	}))
	if err == nil {
		t.Fatal("expected error")
	}
	for _, key := range []string{"BOOKSYNC_VAULT_KEEP_RECENT", "BOOKSYNC_TOKEN_TTL"} {
		if !strings.Contains(err.Error(), key) {
			t.Errorf("error %q does not mention %s", err, key)
		}
	}
}
