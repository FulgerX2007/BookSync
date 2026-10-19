package main

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/store"
)

func TestParseSize(t *testing.T) {
	tests := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"default", 0, true},
		{"DEFAULT", 0, true},
		{"2048", 2048, true},
		{"512K", 512 << 10, true},
		{"5M", 5 << 20, true},
		{"5mb", 5 << 20, true},
		{"5MiB", 5 << 20, true},
		{" 64M ", 64 << 20, true},
		{"1024B", 1024, true},
		{"1023", 0, false}, // below 1K
		{"65M", 0, false},  // above what clients download
		{"1G", 0, false},   // above too
		{"0", 0, false},    // use "default" instead
		{"-5M", 0, false},  // negative
		{"lots", 0, false}, // not a number
		{"5T", 0, false},   // unknown unit
		{"", 0, false},     // empty
	}
	for _, tt := range tests {
		got, err := parseSize(tt.in)
		if (err == nil) != tt.ok || got != tt.want {
			t.Errorf("parseSize(%q) = %d, %v; want %d, ok=%v", tt.in, got, err, tt.want, tt.ok)
		}
	}
}

func TestQuotaCommand(t *testing.T) {
	ctx := context.Background()
	db := filepath.Join(t.TempDir(), "q.db")
	st, err := store.Open(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	u, err := st.CreateUser(ctx, store.NewUser{Username: "alice", AuthHash: []byte{1}, AuthSalt: []byte{2},
		KDF: "pbkdf2-sha256", KDFIterations: 600000, WrappedVaultKey: []byte{3}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.PutVault(ctx, u.ID, "", nil, make([]byte, 2560), store.Retention{KeepRecent: 1}); err != nil {
		t.Fatal(err)
	}
	_ = st.Close()
	env := testEnv(map[string]string{"BOOKSYNC_DB_PATH": db, "BOOKSYNC_MAX_VAULT_BYTES": "10240"})

	run := func(args ...string) string {
		t.Helper()
		var out bytes.Buffer
		if err := quota(ctx, args, env, &out); err != nil {
			t.Fatalf("quota %v: %v", args, err)
		}
		return strings.TrimSpace(out.String())
	}
	if got := run("alice"); got != "alice: limit 10 KiB (server default), vault 2.5 KiB (25%)" {
		t.Fatalf("show: %q", got)
	}
	if got := run("Alice", "5M"); got != "alice: limit 5 MiB (own limit), vault 2.5 KiB (0%)" {
		t.Fatalf("set: %q", got)
	}
	if got := run("alice", "default"); got != "alice: limit 10 KiB (server default), vault 2.5 KiB (25%)" {
		t.Fatalf("reset: %q", got)
	}

	if got := run("--help"); !strings.HasPrefix(got, "usage: booksync-server quota") {
		t.Fatalf("help: %q", got)
	}
	for _, args := range [][]string{{}, {"alice", "5M", "extra"}, {"ghost"}, {"ghost", "5M"}, {"alice", "huge"}} {
		if err := quota(ctx, args, env, &bytes.Buffer{}); err == nil {
			t.Errorf("quota %v: no error", args)
		}
	}
}
