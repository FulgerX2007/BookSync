package store

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func testNewUser(username string) NewUser {
	return NewUser{
		Username:        username,
		AuthHash:        []byte("hash-" + username),
		AuthSalt:        []byte("salt"),
		KDF:             "pbkdf2-sha256",
		KDFIterations:   600000,
		WrappedVaultKey: []byte("wrapped"),
	}
}

func TestCreateAndGetUser(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)

	created, err := s.CreateUser(ctx, testNewUser("alice"))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if created.ID == "" || !created.CreatedAt.Equal(testNow) {
		t.Fatalf("unexpected created user %+v", created)
	}

	byName, err := s.UserByUsername(ctx, "alice")
	if err != nil {
		t.Fatalf("UserByUsername: %v", err)
	}
	byID, err := s.UserByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("UserByID: %v", err)
	}
	for _, got := range []User{byName, byID} {
		if got.ID != created.ID || got.Username != "alice" || got.KDF != "pbkdf2-sha256" ||
			got.KDFIterations != 600000 || !bytes.Equal(got.AuthHash, []byte("hash-alice")) ||
			!bytes.Equal(got.WrappedVaultKey, []byte("wrapped")) || !got.CreatedAt.Equal(testNow) {
			t.Fatalf("round trip mismatch: %+v", got)
		}
	}
}

func TestCreateUserDuplicateUsername(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	if _, err := s.CreateUser(ctx, testNewUser("bob")); err != nil {
		t.Fatal(err)
	}
	_, err := s.CreateUser(ctx, testNewUser("bob"))
	if !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("err = %v, want ErrUsernameTaken", err)
	}
}

func TestUserNotFound(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	if _, err := s.UserByUsername(ctx, "ghost"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("UserByUsername err = %v", err)
	}
	if _, err := s.UserByID(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("UserByID err = %v", err)
	}
	if err := s.DeleteUser(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("DeleteUser err = %v", err)
	}
}

func TestDeleteUserCascades(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	u, err := s.CreateUser(ctx, testNewUser("carol"))
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateUser(ctx, testNewUser("dave"))
	if err != nil {
		t.Fatal(err)
	}
	for _, uid := range []string{u.ID, other.ID} {
		devID := newID()
		mustExec(t, s, `INSERT INTO devices (id, user_id, name, token_hash, created_at, last_seen_at, expires_at)
			VALUES (?, ?, 'laptop', ?, 0, 0, 0)`, devID, uid, []byte(devID))
		mustExec(t, s, `INSERT INTO vault_versions (user_id, version, ciphertext, device_id, created_at)
			VALUES (?, 1, x'00', ?, 0)`, uid, devID)
	}

	if err := s.DeleteUser(ctx, u.ID); err != nil {
		t.Fatalf("DeleteUser: %v", err)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM devices WHERE user_id = ?`, u.ID); n != 0 {
		t.Fatalf("%d devices left for deleted user", n)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM vault_versions WHERE user_id = ?`, u.ID); n != 0 {
		t.Fatalf("%d vault versions left for deleted user", n)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM devices WHERE user_id = ?`, other.ID); n != 1 {
		t.Fatalf("other user's devices affected: %d", n)
	}
}

func mustExec(t *testing.T, s *Store, query string, args ...any) {
	t.Helper()
	if _, err := s.db.Exec(query, args...); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

func count(t *testing.T, s *Store, query string, args ...any) int {
	t.Helper()
	var n int
	if err := s.db.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

func TestVaultLimitAndUsage(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	u, err := s.CreateUser(ctx, testNewUser("erin"))
	if err != nil {
		t.Fatal(err)
	}
	limit, size, err := s.VaultUsage(ctx, u.ID)
	if err != nil || limit != 0 || size != 0 {
		t.Fatalf("new user: limit %d size %d err %v; want the default and an empty vault", limit, size, err)
	}

	if err := s.SetVaultLimit(ctx, "erin", 5<<20); err != nil {
		t.Fatalf("SetVaultLimit: %v", err)
	}
	got, err := s.UserByUsername(ctx, "erin")
	if err != nil || got.MaxVaultBytes != 5<<20 {
		t.Fatalf("UserByUsername: MaxVaultBytes %d err %v", got.MaxVaultBytes, err)
	}
	if _, err := s.PutVault(ctx, u.ID, "", nil, make([]byte, 300), Retention{KeepRecent: 5}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PutVault(ctx, u.ID, "", ptr(int64(1)), make([]byte, 120), Retention{KeepRecent: 5}); err != nil {
		t.Fatal(err)
	}
	limit, size, err = s.VaultUsage(ctx, u.ID)
	if err != nil || limit != 5<<20 || size != 120 {
		t.Fatalf("usage: limit %d size %d err %v; want 5 MiB and the newest version's 120 bytes", limit, size, err)
	}

	if err := s.SetVaultLimit(ctx, "erin", 0); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if limit, _, _ := s.VaultUsage(ctx, u.ID); limit != 0 {
		t.Fatalf("after reset limit = %d, want 0 (default)", limit)
	}
	if err := s.SetVaultLimit(ctx, "ghost", 1<<20); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown user: err = %v", err)
	}
	if _, _, err := s.VaultUsage(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("VaultUsage unknown: err = %v", err)
	}
}
