// Package vault is the client-side model of the decrypted vault document
// (docs/protocol.md §2).
package vault

import (
	"crypto/rand"
	"encoding/base64"
)

// GUID identifies a vault node: 12 base64url characters (72 random bits) for
// ordinary nodes, or one of the fixed root GUIDs.
type GUID = string

const guidBytes = 9

// NewGUID returns a fresh random GUID, the same shape the extension and
// Firefox use (newGuid in extension/src/model/vault.ts).
func NewGUID() GUID {
	b := make([]byte, guidBytes)
	_, _ = rand.Read(b) // crypto/rand.Read never fails on supported platforms
	return base64.RawURLEncoding.EncodeToString(b)
}
