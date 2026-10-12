package auth

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestNewDeviceToken(t *testing.T) {
	seen := map[string]bool{}
	for range 100 {
		plain, hash := NewDeviceToken()
		if !strings.HasPrefix(plain, tokenPrefix) || len(plain) != len(tokenPrefix)+tokenEncodedN {
			t.Fatalf("bad token %q", plain)
		}
		if seen[plain] {
			t.Fatalf("duplicate token %q", plain)
		}
		seen[plain] = true

		again, err := HashToken(plain)
		if err != nil {
			t.Fatalf("HashToken(%q): %v", plain, err)
		}
		if !bytes.Equal(again, hash) {
			t.Fatal("HashToken is not deterministic / differs from issued hash")
		}
	}
}

func TestHashTokenRejectsMalformed(t *testing.T) {
	valid, _ := NewDeviceToken()
	tests := map[string]string{
		"empty":         "",
		"prefix only":   tokenPrefix,
		"wrong prefix":  "xyz_" + strings.TrimPrefix(valid, tokenPrefix),
		"too short":     valid[:len(valid)-1],
		"too long":      valid + "A",
		"bad alphabet":  tokenPrefix + strings.Repeat("!", tokenEncodedN),
		"padded base64": tokenPrefix + strings.Repeat("A", tokenEncodedN-1) + "=",
	}
	for name, tok := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := HashToken(tok); !errors.Is(err, ErrMalformedToken) {
				t.Fatalf("HashToken(%q) err = %v", tok, err)
			}
		})
	}
}
