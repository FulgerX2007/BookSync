// Package auth hashes client auth keys and issues device tokens.
//
// Clients never send their password: they send authKey, a 32-byte value
// derived from password and SyncID. The server stores only an Argon2id hash
// of it, so a database leak does not even reveal authKey.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"

	"golang.org/x/crypto/argon2"
)

// AuthKeySize is the required length of a client auth key.
const AuthKeySize = 32

// ErrInvalidAuthKey is returned for auth keys of the wrong length.
var ErrInvalidAuthKey = errors.New("auth: auth key must be 32 bytes")

// ValidateAuthKey checks the auth key length.
func ValidateAuthKey(k []byte) error {
	if len(k) != AuthKeySize {
		return ErrInvalidAuthKey
	}
	return nil
}

// argonParams is one Argon2id parameter set. Stored hashes are prefixed with
// the set's id so parameters can change later without breaking old hashes.
type argonParams struct {
	id      byte
	memory  uint32 // KiB
	time    uint32
	threads uint8
	keyLen  uint32
}

// currentParams follows the OWASP minimum for Argon2id (m=19 MiB, t=2, p=1).
var currentParams = argonParams{id: 1, memory: 19 * 1024, time: 2, threads: 1, keyLen: 32}

const saltSize = 16

// Hasher hashes and verifies auth keys. Argon2id deliberately costs memory,
// so a semaphore bounds how many hashes run at once.
type Hasher struct {
	sem       chan struct{}
	params    argonParams
	byID      map[byte]argonParams
	dummyHash []byte
	dummySalt []byte
}

// NewHasher returns a Hasher allowing at most concurrency simultaneous hashes.
func NewHasher(concurrency int) *Hasher {
	return newHasher(concurrency, currentParams)
}

// testParams are deliberately cheap. Their id is unknown to NewHasher, so a
// hash produced in tests can never verify on a production hasher.
var testParams = argonParams{id: 0xff, memory: 64, time: 1, threads: 1, keyLen: 32}

// NewTestHasher returns a cheap Hasher for tests in other packages.
func NewTestHasher() *Hasher {
	return newHasher(4, testParams)
}

func newHasher(concurrency int, p argonParams) *Hasher {
	if concurrency < 1 {
		concurrency = 1
	}
	h := &Hasher{
		sem:    make(chan struct{}, concurrency),
		params: p,
		byID:   map[byte]argonParams{p.id: p},
	}
	h.dummySalt = make([]byte, saltSize)
	h.dummyHash = append([]byte{p.id}, h.derive(make([]byte, AuthKeySize), h.dummySalt, p)...)
	return h
}

func (h *Hasher) derive(authKey, salt []byte, p argonParams) []byte {
	return argon2.IDKey(authKey, salt, p.time, p.memory, p.threads, p.keyLen)
}

func (h *Hasher) acquire(ctx context.Context) error {
	select {
	case h.sem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (h *Hasher) release() { <-h.sem }

// Hash returns a new hash and random salt for authKey.
func (h *Hasher) Hash(ctx context.Context, authKey []byte) (hash, salt []byte, err error) {
	if err := ValidateAuthKey(authKey); err != nil {
		return nil, nil, err
	}
	salt = make([]byte, saltSize)
	if _, err := rand.Read(salt); err != nil {
		return nil, nil, fmt.Errorf("salt: %w", err)
	}
	if err := h.acquire(ctx); err != nil {
		return nil, nil, err
	}
	defer h.release()
	return append([]byte{h.params.id}, h.derive(authKey, salt, h.params)...), salt, nil
}

// Verify reports whether authKey matches hash/salt, in constant time.
func (h *Hasher) Verify(ctx context.Context, authKey, hash, salt []byte) (bool, error) {
	if len(hash) < 1 {
		return false, errors.New("auth: empty stored hash")
	}
	p, ok := h.byID[hash[0]]
	if !ok {
		return false, fmt.Errorf("auth: unknown hash parameter set %d", hash[0])
	}
	if err := h.acquire(ctx); err != nil {
		return false, err
	}
	defer h.release()
	if len(authKey) != AuthKeySize {
		// Still burn the same work so a malformed key does not answer faster.
		h.derive(make([]byte, AuthKeySize), salt, p)
		return false, nil
	}
	got := h.derive(authKey, salt, p)
	return subtle.ConstantTimeCompare(got, hash[1:]) == 1, nil
}

// DummyVerify performs the same work as Verify against a fixed hash, so that
// login attempts for unknown usernames take as long as for real ones.
func (h *Hasher) DummyVerify(ctx context.Context) error {
	_, err := h.Verify(ctx, make([]byte, AuthKeySize), h.dummyHash, h.dummySalt)
	return err
}
