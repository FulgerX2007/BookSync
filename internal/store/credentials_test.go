package store

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

var newCreds = Credentials{
	AuthHash:        []byte("new-hash"),
	AuthSalt:        []byte("new-salt"),
	KDF:             "pbkdf2-sha256",
	KDFIterations:   800000,
	WrappedVaultKey: []byte("new-wrapped"),
}

// setupAccount creates a user with two devices and two vault versions.
func setupAccount(t *testing.T, s *Store) (User, Device, Device) {
	t.Helper()
	ctx := context.Background()
	u, d1 := registerUser(t, s, "alice")
	d2, err := s.CreateDevice(ctx, u.ID, newDev("other"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.PutVault(ctx, u.ID, d1.ID, nil, []byte("v1"), defaultRetention); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PutVault(ctx, u.ID, d1.ID, ptr(1), []byte("v2"), defaultRetention); err != nil {
		t.Fatal(err)
	}
	return u, d1, d2
}

func TestChangeCredentialsPlain(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	u, d1, d2 := setupAccount(t, s)

	v, err := s.ChangeCredentials(ctx, u.ID, d1.ID, newCreds, nil)
	if err != nil || v != 0 {
		t.Fatalf("ChangeCredentials = %d, %v", v, err)
	}
	got, err := s.UserByID(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.AuthHash, newCreds.AuthHash) || got.KDFIterations != 800000 || !bytes.Equal(got.WrappedVaultKey, newCreds.WrappedVaultKey) {
		t.Fatalf("credentials not updated: %+v", got)
	}
	if _, err := s.DeviceByTokenHash(ctx, d2.TokenHash); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other device not revoked: %v", err)
	}
	if _, err := s.DeviceByTokenHash(ctx, d1.TokenHash); err != nil {
		t.Fatalf("current device revoked: %v", err)
	}
	if list, _ := s.ListVaultVersions(ctx, u.ID); len(list) != 2 {
		t.Fatalf("plain change must keep history, got %d versions", len(list))
	}
}

func TestChangeCredentialsWithRotation(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	u, d1, _ := setupAccount(t, s)

	v, err := s.ChangeCredentials(ctx, u.ID, d1.ID, newCreds, &VaultRotation{Expected: 2, Ciphertext: []byte("rotated")})
	if err != nil || v != 3 {
		t.Fatalf("ChangeCredentials = %d, %v", v, err)
	}
	list, err := s.ListVaultVersions(ctx, u.ID)
	if err != nil || len(list) != 1 || list[0].Version != 3 {
		t.Fatalf("history after rotation = %+v, %v", list, err)
	}
	latest, err := s.LatestVault(ctx, u.ID)
	if err != nil || !bytes.Equal(latest.Ciphertext, []byte("rotated")) {
		t.Fatalf("latest = %+v, %v", latest, err)
	}
}

func TestChangeCredentialsRotationConflictRollsBack(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	u, d1, d2 := setupAccount(t, s)

	_, err := s.ChangeCredentials(ctx, u.ID, d1.ID, newCreds, &VaultRotation{Expected: 1, Ciphertext: []byte("rotated")})
	var conflict *VersionConflictError
	if !errors.As(err, &conflict) || conflict.Current != 2 {
		t.Fatalf("err = %v, want conflict at 2", err)
	}
	got, _ := s.UserByID(ctx, u.ID)
	if bytes.Equal(got.AuthHash, newCreds.AuthHash) {
		t.Fatal("credentials changed despite conflict")
	}
	if _, err := s.DeviceByTokenHash(ctx, d2.TokenHash); err != nil {
		t.Fatal("other device revoked despite conflict")
	}
	if list, _ := s.ListVaultVersions(ctx, u.ID); len(list) != 2 {
		t.Fatalf("history changed despite conflict: %d versions", len(list))
	}
}

func TestChangeCredentialsRotationOnEmptyVault(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	u, d := registerUser(t, s, "bob")
	v, err := s.ChangeCredentials(ctx, u.ID, d.ID, newCreds, &VaultRotation{Expected: 0, Ciphertext: []byte("first")})
	if err != nil || v != 1 {
		t.Fatalf("ChangeCredentials = %d, %v", v, err)
	}
}

func TestChangeCredentialsUnknownUser(t *testing.T) {
	s := openTestStore(t)
	if _, err := s.ChangeCredentials(context.Background(), "ghost", "dev", newCreds, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}
