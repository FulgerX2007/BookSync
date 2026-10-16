package crypto

import (
	"bytes"
	"encoding/hex"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/client/conformance"
)

func unhex(t testing.TB, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The protocol §1.2 vector was computed independently (Python hashlib +
// RFC 5869). Never regenerate it from the code under test.
func TestDeriveKeysProtocolVector(t *testing.T) {
	sid := make([]byte, 16)
	for i := range sid {
		sid[i] = byte(i)
	}
	k, err := deriveKeys("alice", "correct horse battery staple", sid, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(k.AuthKey); got != "bb4e76c9004b496b6e50c1845c3a1a3ee6d695c95f1dbef3a76cd6b1213dd01d" {
		t.Errorf("authKey = %s", got)
	}
	if got := hex.EncodeToString(k.KEK); got != "bf7ae07aff0552d9d1f011eae6d27296ea6897b14c47fd28b5cb767a6192829b" {
		t.Errorf("kek = %s", got)
	}
}

type keysInput struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	PasswordNFC string `json:"passwordNFC"`
	SyncID      string `json:"syncId"`
	Iterations  int    `json:"iterations"`
}

type keysExpected struct {
	AuthKey         string `json:"authKey"`
	VaultKey        string `json:"vaultKey"`
	WrappedVaultKey string `json:"wrappedVaultKey"`
}

func TestKeysConformance(t *testing.T) {
	for _, c := range conformance.Load[keysInput, keysExpected](t, "keys.json") {
		t.Run(c.Name, func(t *testing.T) {
			// Go receives passwords already NFC-normalized (the Android app
			// normalizes in Kotlin), so use the normalized form when given.
			pw := c.Input.Password
			if c.Input.PasswordNFC != "" {
				pw = c.Input.PasswordNFC
			}
			k, err := deriveKeys(c.Input.Username, pw, unhex(t, c.Input.SyncID), c.Input.Iterations)
			if err != nil {
				t.Fatal(err)
			}
			if got := hex.EncodeToString(k.AuthKey); got != c.Expected.AuthKey {
				t.Fatalf("authKey = %s, want %s", got, c.Expected.AuthKey)
			}
			if c.Expected.WrappedVaultKey == "" {
				return
			}
			raw, err := UnwrapVaultKey(unhex(t, c.Expected.WrappedVaultKey), k.KEK, c.Input.Username)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(raw, unhex(t, c.Expected.VaultKey)) {
				t.Fatalf("unwrapped vault key differs")
			}
		})
	}
}

func TestDeriveKeysRefusesWeakParameters(t *testing.T) {
	if _, err := DeriveKeys("alice", "pw", make([]byte, 16), 1000); CodeOf(err) != CodeWeakKDF {
		t.Fatalf("err = %v, want weak_kdf", err)
	}
}

func TestCheckKDF(t *testing.T) {
	tests := []struct {
		name       string
		kdf        string
		iterations int
		ok         bool
	}{
		{"minimum", KDFName, MinIterations, true},
		{"maximum", KDFName, MaxIterations, true},
		{"just below minimum", KDFName, MinIterations - 1, false},
		{"above maximum", KDFName, MaxIterations + 1, false},
		{"zero", KDFName, 0, false},
		{"other kdf", "md5", MinIterations, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := CheckKDF(tt.kdf, tt.iterations)
			if (err == nil) != tt.ok {
				t.Fatalf("CheckKDF(%q, %d) = %v", tt.kdf, tt.iterations, err)
			}
			if err != nil && CodeOf(err) != CodeWeakKDF {
				t.Fatalf("code = %q", CodeOf(err))
			}
		})
	}
}

func TestUsernames(t *testing.T) {
	if got := NormalizeUsername("  Alice "); got != "alice" {
		t.Errorf("NormalizeUsername = %q", got)
	}
	for u, ok := range map[string]bool{"alice": true, "a.b_c-9": true, "al": false, "a b c": false, "Alice": false} {
		if ValidUsername(u) != ok {
			t.Errorf("ValidUsername(%q) = %v", u, !ok)
		}
	}
}

func TestWrapRoundTripAndFailures(t *testing.T) {
	kek := NewVaultKey()
	vk := NewVaultKey()
	wrapped, err := WrapVaultKey(vk, kek, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if len(wrapped) != ivSize+KeySize+tagSize {
		t.Fatalf("wrapped length = %d", len(wrapped))
	}
	got, err := UnwrapVaultKey(wrapped, kek, "alice")
	if err != nil || !bytes.Equal(got, vk) {
		t.Fatalf("round trip: %v", err)
	}
	tampered := bytes.Clone(wrapped)
	tampered[len(tampered)-1] ^= 1
	for name, tc := range map[string]struct {
		wrapped, kek []byte
		user         string
	}{
		"wrong kek":  {wrapped, NewVaultKey(), "alice"},
		"wrong user": {wrapped, kek, "bob"},
		"tampered":   {tampered, kek, "alice"},
		"truncated":  {wrapped[:20], kek, "alice"},
	} {
		if _, err := UnwrapVaultKey(tc.wrapped, tc.kek, tc.user); CodeOf(err) != CodeAuthFailed {
			t.Errorf("%s: err = %v, want auth_failed", name, err)
		}
	}
}
