package auth

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"
)

// fastParams keeps unit tests quick; TestRealParams covers production cost.
var fastParams = argonParams{id: 1, memory: 64, time: 1, threads: 1, keyLen: 32}

func key(b byte) []byte { return bytes.Repeat([]byte{b}, AuthKeySize) }

func TestHashVerifyRoundTrip(t *testing.T) {
	ctx := context.Background()
	h := newHasher(2, fastParams)
	hash, salt, err := h.Hash(ctx, key(1))
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	ok, err := h.Verify(ctx, key(1), hash, salt)
	if err != nil || !ok {
		t.Fatalf("Verify(correct) = %v, %v", ok, err)
	}
	ok, err = h.Verify(ctx, key(2), hash, salt)
	if err != nil || ok {
		t.Fatalf("Verify(wrong) = %v, %v", ok, err)
	}
}

func TestRealParams(t *testing.T) {
	ctx := context.Background()
	h := NewHasher(1)
	hash, salt, err := h.Hash(ctx, key(7))
	if err != nil {
		t.Fatal(err)
	}
	if hash[0] != currentParams.id || len(hash) != 1+int(currentParams.keyLen) {
		t.Fatalf("unexpected hash layout: len=%d id=%d", len(hash), hash[0])
	}
	if ok, err := h.Verify(ctx, key(7), hash, salt); err != nil || !ok {
		t.Fatalf("Verify = %v, %v", ok, err)
	}
}

func TestHashUsesFreshSalt(t *testing.T) {
	ctx := context.Background()
	h := newHasher(1, fastParams)
	h1, s1, err := h.Hash(ctx, key(3))
	if err != nil {
		t.Fatal(err)
	}
	h2, s2, err := h.Hash(ctx, key(3))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(s1, s2) || bytes.Equal(h1, h2) {
		t.Fatal("two hashes of the same key share salt or hash")
	}
}

func TestHashRejectsWrongLengthKey(t *testing.T) {
	h := newHasher(1, fastParams)
	if _, _, err := h.Hash(context.Background(), []byte("short")); !errors.Is(err, ErrInvalidAuthKey) {
		t.Fatalf("err = %v, want ErrInvalidAuthKey", err)
	}
}

func TestVerifyWrongLengthKeyIsFalse(t *testing.T) {
	ctx := context.Background()
	h := newHasher(1, fastParams)
	hash, salt, err := h.Hash(ctx, key(1))
	if err != nil {
		t.Fatal(err)
	}
	ok, err := h.Verify(ctx, []byte("short"), hash, salt)
	if err != nil || ok {
		t.Fatalf("Verify(short) = %v, %v", ok, err)
	}
}

func TestVerifyUnknownParamSet(t *testing.T) {
	h := newHasher(1, fastParams)
	if _, err := h.Verify(context.Background(), key(1), []byte{99, 1, 2}, nil); err == nil {
		t.Fatal("expected error for unknown parameter set")
	}
	if _, err := h.Verify(context.Background(), key(1), nil, nil); err == nil {
		t.Fatal("expected error for empty hash")
	}
}

func TestSemaphoreHonorsContext(t *testing.T) {
	h := newHasher(1, fastParams)
	h.sem <- struct{}{} // occupy the only slot
	defer h.release()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, _, err := h.Hash(ctx, key(1)); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Hash err = %v, want deadline exceeded", err)
	}
	if err := h.DummyVerify(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("DummyVerify err = %v, want deadline exceeded", err)
	}
}

func TestDummyVerify(t *testing.T) {
	if err := newHasher(1, fastParams).DummyVerify(context.Background()); err != nil {
		t.Fatalf("DummyVerify: %v", err)
	}
}

func TestValidateAuthKey(t *testing.T) {
	for _, n := range []int{0, 16, 31, 33, 64} {
		if err := ValidateAuthKey(make([]byte, n)); !errors.Is(err, ErrInvalidAuthKey) {
			t.Errorf("len %d: err = %v", n, err)
		}
	}
	if err := ValidateAuthKey(make([]byte, AuthKeySize)); err != nil {
		t.Errorf("len 32: %v", err)
	}
}
