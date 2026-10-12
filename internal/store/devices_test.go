package store

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"
)

func newDev(name string) NewDevice {
	return NewDevice{Name: name, TokenHash: []byte("token-" + name + newID()), TTL: 24 * time.Hour}
}

func TestRegisterCreatesUserAndDevice(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	u, d, err := s.Register(ctx, testNewUser("erin"), newDev("laptop"))
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if d.UserID != u.ID || d.Name != "laptop" {
		t.Fatalf("device not linked: %+v", d)
	}
	if !d.ExpiresAt.Equal(testNow.Add(24 * time.Hour)) {
		t.Fatalf("expires = %v", d.ExpiresAt)
	}
	got, err := s.DeviceByTokenHash(ctx, d.TokenHash)
	if err != nil {
		t.Fatalf("DeviceByTokenHash: %v", err)
	}
	if got.ID != d.ID || !bytes.Equal(got.TokenHash, d.TokenHash) || !got.CreatedAt.Equal(testNow) {
		t.Fatalf("round trip mismatch: %+v", got)
	}
}

func TestRegisterDuplicateLeavesNoDevice(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	if _, _, err := s.Register(ctx, testNewUser("fay"), newDev("a")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Register(ctx, testNewUser("fay"), newDev("b")); !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("err = %v, want ErrUsernameTaken", err)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM devices`); n != 1 {
		t.Fatalf("%d devices, want 1 (failed register must roll back)", n)
	}
}

func TestDeviceLifecycle(t *testing.T) {
	ctx := context.Background()
	now := testNow
	s := openTestStore(t)
	s.now = func() time.Time { return now }

	u, d1, err := s.Register(ctx, testNewUser("gus"), newDev("one"))
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	d2, err := s.CreateDevice(ctx, u.ID, newDev("two"))
	if err != nil {
		t.Fatal(err)
	}

	list, err := s.ListDevices(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].ID != d1.ID || list[1].ID != d2.ID {
		t.Fatalf("ListDevices = %+v", list)
	}

	now = now.Add(time.Hour)
	if err := s.TouchDevice(ctx, d1.ID, 48*time.Hour); err != nil {
		t.Fatalf("TouchDevice: %v", err)
	}
	got, err := s.DeviceByTokenHash(ctx, d1.TokenHash)
	if err != nil {
		t.Fatal(err)
	}
	if !got.LastSeenAt.Equal(now) || !got.ExpiresAt.Equal(now.Add(48*time.Hour)) {
		t.Fatalf("touch not applied: %+v", got)
	}

	if err := s.DeleteDevice(ctx, u.ID, d1.ID); err != nil {
		t.Fatalf("DeleteDevice: %v", err)
	}
	if _, err := s.DeviceByTokenHash(ctx, d1.TokenHash); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted device still found: %v", err)
	}
}

func TestDeleteDeviceScopedToUser(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	_, d, err := s.Register(ctx, testNewUser("hal"), newDev("x"))
	if err != nil {
		t.Fatal(err)
	}
	other, _, err := s.Register(ctx, testNewUser("ivy"), newDev("y"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteDevice(ctx, other.ID, d.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-user delete err = %v, want ErrNotFound", err)
	}
	if _, err := s.DeviceByTokenHash(ctx, d.TokenHash); err != nil {
		t.Fatalf("device was deleted by another user: %v", err)
	}
}

func TestDeviceNotFound(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	if _, err := s.DeviceByTokenHash(ctx, []byte("missing")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	if err := s.TouchDevice(ctx, "missing", time.Hour); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	list, err := s.ListDevices(ctx, "nobody")
	if err != nil || len(list) != 0 {
		t.Fatalf("ListDevices = %v, %v", list, err)
	}
}
