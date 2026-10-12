package store

import (
	"bytes"
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"
)

var defaultRetention = Retention{KeepRecent: 10, KeepDays: 30}

func ptr(v int64) *int64 { return &v }

func registerUser(t *testing.T, s *Store, name string) (User, Device) {
	t.Helper()
	u, d, err := s.Register(context.Background(), testNewUser(name), newDev(name))
	if err != nil {
		t.Fatal(err)
	}
	return u, d
}

func TestPutVaultVersioning(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	u, d := registerUser(t, s, "alice")

	if _, err := s.LatestVault(ctx, u.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty vault err = %v", err)
	}

	// The first write must assert emptiness.
	var conflict *VersionConflictError
	if _, err := s.PutVault(ctx, u.ID, d.ID, ptr(1), []byte("x"), defaultRetention); !errors.As(err, &conflict) || conflict.Current != 0 {
		t.Fatalf("put with expected=1 on empty vault: %v", err)
	}
	v, err := s.PutVault(ctx, u.ID, d.ID, nil, []byte("v1"), defaultRetention)
	if err != nil || v != 1 {
		t.Fatalf("first put = %d, %v", v, err)
	}
	if _, err := s.PutVault(ctx, u.ID, d.ID, nil, []byte("again"), defaultRetention); !errors.As(err, &conflict) || conflict.Current != 1 {
		t.Fatalf("second create-only put: %v", err)
	}
	for want := int64(2); want <= 3; want++ {
		got, err := s.PutVault(ctx, u.ID, d.ID, ptr(want-1), []byte{byte(want)}, defaultRetention)
		if err != nil || got != want {
			t.Fatalf("put #%d = %d, %v", want, got, err)
		}
	}
	if _, err := s.PutVault(ctx, u.ID, d.ID, ptr(1), []byte("stale"), defaultRetention); !errors.As(err, &conflict) || conflict.Current != 3 {
		t.Fatalf("stale put: %v", err)
	}

	latest, err := s.LatestVault(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if latest.Version != 3 || !bytes.Equal(latest.Ciphertext, []byte{3}) || latest.DeviceID != d.ID || latest.Size != 1 {
		t.Fatalf("latest = %+v", latest)
	}
	old, err := s.VaultVersion(ctx, u.ID, 1)
	if err != nil || !bytes.Equal(old.Ciphertext, []byte("v1")) {
		t.Fatalf("version 1 = %+v, %v", old, err)
	}
}

func TestVaultIsolatedPerUser(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	alice, ad := registerUser(t, s, "alice")
	bob, bd := registerUser(t, s, "bob")

	if _, err := s.PutVault(ctx, alice.ID, ad.ID, nil, []byte("a"), defaultRetention); err != nil {
		t.Fatal(err)
	}
	if v, err := s.PutVault(ctx, bob.ID, bd.ID, nil, []byte("b"), defaultRetention); err != nil || v != 1 {
		t.Fatalf("bob's first put = %d, %v", v, err)
	}
	if _, err := s.VaultVersion(ctx, bob.ID, 1); err != nil {
		t.Fatal(err)
	}
	got, err := s.LatestVault(ctx, alice.ID)
	if err != nil || !bytes.Equal(got.Ciphertext, []byte("a")) {
		t.Fatalf("alice's vault = %+v, %v", got, err)
	}
	if _, err := s.VaultVersion(ctx, alice.ID, 2); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing version err = %v", err)
	}
}

func TestVaultRetention(t *testing.T) {
	ctx := context.Background()
	day0 := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	now := day0
	s := openTestStore(t)
	s.now = func() time.Time { return now }
	u, d := registerUser(t, s, "alice")

	put := func() int64 {
		t.Helper()
		latest, err := s.LatestVault(ctx, u.ID)
		var expected *int64
		if err == nil {
			expected = ptr(latest.Version)
		}
		v, err := s.PutVault(ctx, u.ID, d.ID, expected, []byte("x"), defaultRetention)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}

	// One version per day for 40 days (version i+1 on day i)...
	for i := range 40 {
		now = day0.AddDate(0, 0, i)
		put()
	}
	// ...then a burst of 50 edits on the last day (versions 41-90).
	for k := range 50 {
		now = day0.AddDate(0, 0, 39).Add(time.Duration(k+1) * time.Minute)
		put()
	}

	list, err := s.ListVaultVersions(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	var got []int64
	for _, v := range list {
		got = append(got, v.Version)
	}
	slices.Sort(got)

	// Daily keepers for days 9..38 (versions 10..39) survive the burst,
	// plus the 10 newest versions; days before the 30-day window are gone.
	var want []int64
	for v := int64(10); v <= 39; v++ {
		want = append(want, v)
	}
	for v := int64(81); v <= 90; v++ {
		want = append(want, v)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("kept versions\n got %v\nwant %v", got, want)
	}
}

func TestVaultRetentionWithoutDaily(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	u, d := registerUser(t, s, "alice")
	ret := Retention{KeepRecent: 3, KeepDays: 0}
	var expected *int64
	for range 6 {
		v, err := s.PutVault(ctx, u.ID, d.ID, expected, []byte("x"), ret)
		if err != nil {
			t.Fatal(err)
		}
		expected = ptr(v)
	}
	list, err := s.ListVaultVersions(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 || list[0].Version != 6 || list[2].Version != 4 {
		t.Fatalf("list = %+v", list)
	}
}

func TestListVaultVersionsMetadata(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	u, d := registerUser(t, s, "alice")
	if _, err := s.PutVault(ctx, u.ID, d.ID, nil, []byte("12345"), defaultRetention); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PutVault(ctx, u.ID, "", ptr(1), []byte("12"), defaultRetention); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListVaultVersions(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("len = %d", len(list))
	}
	if list[0].Version != 2 || list[0].Size != 2 || list[0].DeviceName != "" || list[0].Ciphertext != nil {
		t.Fatalf("newest = %+v", list[0])
	}
	if list[1].Version != 1 || list[1].Size != 5 || list[1].DeviceName != "alice" || !list[1].CreatedAt.Equal(testNow) {
		t.Fatalf("oldest = %+v", list[1])
	}

	// Deleting the writing device keeps the version but drops the attribution.
	if err := s.DeleteDevice(ctx, u.ID, d.ID); err != nil {
		t.Fatal(err)
	}
	list, err = s.ListVaultVersions(ctx, u.ID)
	if err != nil || len(list) != 2 || list[1].DeviceID != "" || list[1].DeviceName != "" {
		t.Fatalf("after device delete: %+v, %v", list, err)
	}
}

func TestPutVaultConcurrentWritersSerialize(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	u, d := registerUser(t, s, "alice")
	if _, err := s.PutVault(ctx, u.ID, d.ID, nil, []byte("base"), defaultRetention); err != nil {
		t.Fatal(err)
	}

	const writers = 10
	var wg sync.WaitGroup
	results := make(chan error, writers)
	for i := range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.PutVault(ctx, u.ID, d.ID, ptr(1), []byte{byte(i)}, defaultRetention)
			results <- err
		}()
	}
	wg.Wait()
	close(results)

	var ok, conflicts int
	for err := range results {
		var conflict *VersionConflictError
		switch {
		case err == nil:
			ok++
		case errors.As(err, &conflict) && conflict.Current == 2:
			conflicts++
		default:
			t.Errorf("unexpected error: %v", err)
		}
	}
	if ok != 1 || conflicts != writers-1 {
		t.Fatalf("ok=%d conflicts=%d, want 1 and %d", ok, conflicts, writers-1)
	}
}
