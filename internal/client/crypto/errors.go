// Package crypto implements the client cryptography of docs/protocol.md §1:
// key derivation, vault-key wrapping, the vault envelope and the SyncID.
// It mirrors extension/src/crypto; the golden corpus keeps them in step.
package crypto

import "errors"

// Error codes, shared with the extension (CryptoErrorCode in errors.ts).
const (
	CodeInvalidFormat   = "invalid_format"   // SyncID is not well-formed
	CodeInvalidChecksum = "invalid_checksum" // SyncID has a typo
	CodeWeakKDF         = "weak_kdf"         // KDF parameters below our minimum
	CodeBadMagic        = "bad_magic"        // not a BookSync vault envelope
	CodeAuthFailed      = "auth_failed"      // wrong key, wrong user or tampered
	CodeBadFormat       = "bad_format"       // authenticated plaintext is not a gzip stream
)

// Error is a crypto failure with a stable code that callers branch on.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return "crypto: " + e.Message }

func newError(code, msg string) *Error { return &Error{Code: code, Message: msg} }

// CodeOf returns the code of a crypto *Error in err's chain, or "".
func CodeOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}
