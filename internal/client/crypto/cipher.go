package crypto

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"errors"
	"io"
)

// MaxPlaintextBytes caps a decompressed vault, so a hostile envelope cannot
// exhaust memory. Real vaults are far smaller (the server caps the envelope).
const MaxPlaintextBytes = 64 << 20

// maxPlaintext is MaxPlaintextBytes; tests lower it.
var maxPlaintext = MaxPlaintextBytes

var magic = []byte("BSV1")

func vaultAAD(username string) []byte { return []byte("booksync/v1/vault|" + username) }

// SealVault returns "BSV1" ‖ iv ‖ AES-256-GCM(vaultKey, iv, aad, gzip(plaintext))
// (protocol §1.4). plaintext is the UTF-8 JSON of a vault document.
func SealVault(plaintext, vaultKey []byte, username string) ([]byte, error) {
	return sealVault(rand.Reader, plaintext, vaultKey, username)
}

func sealVault(r io.Reader, plaintext, vaultKey []byte, username string) ([]byte, error) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(plaintext); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return seal(r, vaultKey, vaultAAD(username), buf.Bytes(), append([]byte(nil), magic...))
}

// HasVaultMagic reports whether data starts with the envelope magic.
func HasVaultMagic(data []byte) bool { return bytes.HasPrefix(data, magic) }

// OpenVault decrypts an envelope and returns the decompressed JSON. A
// decryption failure is always an error, never an empty vault.
func OpenVault(envelope, vaultKey []byte, username string) ([]byte, error) {
	if !HasVaultMagic(envelope) || len(envelope) < len(magic)+ivSize+tagSize {
		return nil, newError(CodeBadMagic, "not a BookSync vault")
	}
	compressed, err := open(vaultKey, vaultAAD(username), envelope[len(magic):])
	if err != nil {
		return nil, newError(CodeAuthFailed, "vault could not be decrypted (wrong key, wrong user or tampered)")
	}
	zr, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, newError(CodeBadFormat, "vault plaintext is not gzip")
	}
	plain, err := io.ReadAll(io.LimitReader(zr, int64(maxPlaintext)+1))
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, newError(CodeBadFormat, "vault plaintext is not valid gzip")
	}
	if len(plain) > maxPlaintext {
		return nil, newError(CodeBadFormat, "vault plaintext is too large")
	}
	return plain, nil
}
