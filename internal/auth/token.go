package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

const (
	tokenPrefix   = "bst_"
	tokenBytes    = 32
	tokenEncodedN = 43 // base64url without padding of 32 bytes
)

// ErrMalformedToken is returned for tokens that cannot have been issued by us.
var ErrMalformedToken = errors.New("auth: malformed device token")

// NewDeviceToken returns a fresh bearer token and the hash to store for it.
// Only the hash is persisted; the plain token is shown to the client once.
func NewDeviceToken() (plain string, hash []byte) {
	b := make([]byte, tokenBytes)
	_, _ = rand.Read(b) // crypto/rand.Read never fails on supported platforms
	plain = tokenPrefix + base64.RawURLEncoding.EncodeToString(b)
	sum := sha256.Sum256([]byte(plain))
	return plain, sum[:]
}

// HashToken validates the token format and returns its SHA-256 hash.
// Tokens carry 256 random bits, so a fast hash is sufficient.
func HashToken(plain string) ([]byte, error) {
	body, ok := strings.CutPrefix(plain, tokenPrefix)
	if !ok || len(body) != tokenEncodedN {
		return nil, ErrMalformedToken
	}
	if _, err := base64.RawURLEncoding.DecodeString(body); err != nil {
		return nil, ErrMalformedToken
	}
	sum := sha256.Sum256([]byte(plain))
	return sum[:], nil
}
