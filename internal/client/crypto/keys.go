package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"io"
	"regexp"
	"strings"
)

// KDF parameters (protocol §1.2). The client refuses anything weaker from
// the server, so a malicious server cannot downgrade the derivation.
const (
	KDFName       = "pbkdf2-sha256"
	MinIterations = 600_000
	MaxIterations = 10_000_000
	KeySize       = 32 // authKey, kek and vault key
	ivSize        = 12
	tagSize       = 16
)

var usernameRE = regexp.MustCompile(`^[a-z0-9._-]{3,64}$`)

// NormalizeUsername applies the server's rule: trimmed and lowercased.
func NormalizeUsername(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}

// ValidUsername reports whether a normalized username is acceptable.
func ValidUsername(u string) bool { return usernameRE.MatchString(u) }

// CheckKDF refuses KDF parameters weaker (or absurdly stronger) than ours.
func CheckKDF(kdf string, iterations int) error {
	if kdf != KDFName || iterations < MinIterations || iterations > MaxIterations {
		return newError(CodeWeakKDF, "refusing key derivation parameters")
	}
	return nil
}

// Keys are the values derived from password and SyncID.
type Keys struct {
	// AuthKey is sent to the server as proof of password + SyncID.
	AuthKey []byte
	// KEK wraps the vault key; it never leaves the device.
	KEK []byte
}

// DeriveKeys derives authKey and kek (protocol §1.2).
//
// The password MUST already be normalized to NFC: Go's standard library has
// no Unicode normalization, so callers (the Android app, in Kotlin) do it.
func DeriveKeys(username, nfcPassword string, syncID []byte, iterations int) (Keys, error) {
	if err := CheckKDF(KDFName, iterations); err != nil {
		return Keys{}, err
	}
	return deriveKeys(username, nfcPassword, syncID, iterations)
}

// deriveKeys skips the parameter check; tests use it with few iterations.
func deriveKeys(username, nfcPassword string, syncID []byte, iterations int) (Keys, error) {
	salt := sha256.Sum256([]byte("booksync/v1|" + username))
	stretched, err := pbkdf2.Key(sha256.New, nfcPassword, salt[:], iterations, KeySize)
	if err != nil {
		return Keys{}, err
	}
	authKey, err := hkdf.Key(sha256.New, stretched, syncID, "booksync/v1/auth", KeySize)
	if err != nil {
		return Keys{}, err
	}
	kek, err := hkdf.Key(sha256.New, stretched, syncID, "booksync/v1/kek", KeySize)
	if err != nil {
		return Keys{}, err
	}
	return Keys{AuthKey: authKey, KEK: kek}, nil
}

// NewVaultKey returns a fresh random 32-byte vault key.
func NewVaultKey() []byte {
	k := make([]byte, KeySize)
	_, _ = rand.Read(k) // crypto/rand.Read never fails on supported platforms
	return k
}

func wrapAAD(username string) []byte { return []byte("booksync/v1/wrap|" + username) }

// WrapVaultKey returns iv ‖ AES-256-GCM(kek, iv, aad, vaultKey) (protocol §1.3).
func WrapVaultKey(vaultKey, kek []byte, username string) ([]byte, error) {
	return seal(rand.Reader, kek, wrapAAD(username), vaultKey, nil)
}

// UnwrapVaultKey reverses WrapVaultKey. Any failure is auth_failed: a wrong
// password or SyncID gives a wrong kek.
func UnwrapVaultKey(wrapped, kek []byte, username string) ([]byte, error) {
	if len(wrapped) < ivSize+tagSize {
		return nil, newError(CodeAuthFailed, "wrapped vault key is truncated")
	}
	raw, err := open(kek, wrapAAD(username), wrapped)
	if err != nil {
		return nil, newError(CodeAuthFailed, "could not unwrap the vault key (wrong password or SyncID)")
	}
	return raw, nil
}

// seal appends iv ‖ ciphertext ‖ tag to prefix, with an IV read from r.
func seal(r io.Reader, key, aad, plaintext, prefix []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	iv := make([]byte, ivSize)
	if _, err := io.ReadFull(r, iv); err != nil {
		return nil, err
	}
	out := append(append(prefix, iv...), gcm.Seal(nil, iv, plaintext, aad)...)
	return out, nil
}

// open decrypts iv ‖ ciphertext ‖ tag.
func open(key, aad, data []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, data[:ivSize], data[ivSize:], aad)
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
