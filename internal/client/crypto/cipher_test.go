package crypto

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/client/conformance"
)

type envelopeInput struct {
	Username string `json:"username"`
	VaultKey string `json:"vaultKey"`
	Envelope string `json:"envelope"`
}

type envelopeExpected struct {
	Doc json.RawMessage `json:"doc"`
}

func sameJSON(t testing.TB, a, b []byte) bool {
	t.Helper()
	var x, y any
	if err := json.Unmarshal(a, &x); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &y); err != nil {
		t.Fatal(err)
	}
	return reflect.DeepEqual(x, y)
}

// TS envelopes (CompressionStream gzip, WebCrypto AES-GCM) open in Go.
func TestOpenVaultConformance(t *testing.T) {
	for _, c := range conformance.Load[envelopeInput, envelopeExpected](t, "envelope.json") {
		t.Run(c.Name, func(t *testing.T) {
			env, err := base64.StdEncoding.DecodeString(c.Input.Envelope)
			if err != nil {
				t.Fatal(err)
			}
			plain, err := OpenVault(env, unhex(t, c.Input.VaultKey), c.Input.Username)
			if err != nil {
				t.Fatal(err)
			}
			if !sameJSON(t, plain, c.Expected.Doc) {
				t.Fatalf("decrypted document differs:\n%s", plain)
			}
		})
	}
}

func TestSealOpenRoundTrip(t *testing.T) {
	key := NewVaultKey()
	plain := []byte(`{"format":1}`)
	env, err := SealVault(plain, key, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if !HasVaultMagic(env) {
		t.Fatal("missing magic")
	}
	again, _ := SealVault(plain, key, "alice")
	if bytes.Equal(env, again) {
		t.Fatal("two seals share an IV")
	}
	got, err := OpenVault(env, key, "alice")
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("round trip: %q, %v", got, err)
	}
}

func TestOpenVaultFailures(t *testing.T) {
	key := NewVaultKey()
	env, _ := SealVault([]byte(`{}`), key, "alice")
	tampered := bytes.Clone(env)
	tampered[len(tampered)-5] ^= 1
	notGzip, _ := seal(rand.Reader, key, vaultAAD("alice"), []byte("plain"), []byte("BSV1"))

	defer func(old int) { maxPlaintext = old }(maxPlaintext)
	maxPlaintext = 1024
	var bomb bytes.Buffer
	zw := gzip.NewWriter(&bomb)
	_, _ = zw.Write([]byte(strings.Repeat("x", maxPlaintext+1)))
	_ = zw.Close()
	tooBig, _ := seal(rand.Reader, key, vaultAAD("alice"), bomb.Bytes(), []byte("BSV1"))

	tests := []struct {
		name string
		env  []byte
		key  []byte
		user string
		code string
	}{
		{"wrong key", env, NewVaultKey(), "alice", CodeAuthFailed},
		{"wrong user (AAD)", env, key, "bob", CodeAuthFailed},
		{"tampered", tampered, key, "alice", CodeAuthFailed},
		{"bad magic", append([]byte("BSV2"), env[4:]...), key, "alice", CodeBadMagic},
		{"too short", env[:31], key, "alice", CodeBadMagic},
		{"empty", nil, key, "alice", CodeBadMagic},
		{"not gzip", notGzip, key, "alice", CodeBadFormat},
		{"decompresses too large", tooBig, key, "alice", CodeBadFormat},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := OpenVault(tt.env, tt.key, tt.user); CodeOf(err) != tt.code {
				t.Fatalf("err = %v, want %s", err, tt.code)
			}
		})
	}
}

func TestCodeOf(t *testing.T) {
	if CodeOf(nil) != "" || CodeOf(newError(CodeBadMagic, "x")) != CodeBadMagic {
		t.Fatal("CodeOf")
	}
	if !strings.HasPrefix(newError(CodeBadMagic, "x").Error(), "crypto: ") {
		t.Fatal("Error()")
	}
}
