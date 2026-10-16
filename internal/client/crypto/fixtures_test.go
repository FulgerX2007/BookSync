package crypto

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"flag"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/client/conformance"
	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

var update = flag.Bool("update", false, "rewrite the Go-written fixtures in testdata/conformance")

// detReader is a deterministic byte stream (SHA-256 in counter mode), so
// regenerated fixtures only change when the code does.
type detReader struct {
	seed string
	n    uint64
	buf  []byte
}

func (r *detReader) Read(p []byte) (int, error) {
	for len(r.buf) < len(p) {
		var ctr [8]byte
		binary.BigEndian.PutUint64(ctr[:], r.n)
		r.n++
		sum := sha256.Sum256(append([]byte(r.seed), ctr[:]...))
		r.buf = append(r.buf, sum[:]...)
	}
	n := copy(p, r.buf)
	r.buf = r.buf[n:]
	return n, nil
}

type wrapGoInput struct {
	Username        string `json:"username"`
	Password        string `json:"password"`
	SyncID          string `json:"syncId"`
	Iterations      int    `json:"iterations"`
	VaultKey        string `json:"vaultKey"`
	WrappedVaultKey string `json:"wrappedVaultKey"`
}

// TestGoFixtures writes (with -update) and always verifies the envelopes and
// wrapped keys that extension/test/conformance/go-fixtures.test.ts decrypts.
func TestGoFixtures(t *testing.T) {
	if *update {
		writeGoFixtures(t)
	}
	for _, c := range conformance.Load[envelopeInput, envelopeExpected](t, "envelope-go.json") {
		env, _ := base64.StdEncoding.DecodeString(c.Input.Envelope)
		plain, err := OpenVault(env, unhex(t, c.Input.VaultKey), c.Input.Username)
		if err != nil || !sameJSON(t, plain, c.Expected.Doc) {
			t.Fatalf("%s: Go cannot read its own fixture: %v", c.Name, err)
		}
	}
	for _, c := range conformance.Load[wrapGoInput, struct{}](t, "wrap-go.json") {
		k, err := deriveKeys(c.Input.Username, c.Input.Password, unhex(t, c.Input.SyncID), c.Input.Iterations)
		if err != nil {
			t.Fatal(err)
		}
		got, err := UnwrapVaultKey(unhex(t, c.Input.WrappedVaultKey), k.KEK, c.Input.Username)
		if err != nil || hex.EncodeToString(got) != c.Input.VaultKey {
			t.Fatalf("%s: %v", c.Name, err)
		}
	}
}

func writeGoFixtures(t *testing.T) {
	t.Helper()
	// The plaintexts are the TS corpus's edge-case documents (empty folder,
	// empty url, escapes, non-ASCII), parsed and re-encoded by the Go vault
	// package exactly as an Android device uploads them.
	var envs []conformance.Case[envelopeInput, envelopeExpected]
	for _, c := range conformance.Load[envelopeInput, envelopeExpected](t, "envelope.json") {
		doc, err := vault.Parse(c.Expected.Doc)
		if err != nil {
			t.Fatal(err)
		}
		plain, err := vault.Marshal(doc)
		if err != nil {
			t.Fatal(err)
		}
		r := &detReader{seed: "envelope/" + c.Name}
		key := make([]byte, KeySize)
		_, _ = r.Read(key)
		env, err := sealVault(r, plain, key, c.Input.Username)
		if err != nil {
			t.Fatal(err)
		}
		envs = append(envs, conformance.Case[envelopeInput, envelopeExpected]{
			Name:     c.Name,
			Input:    envelopeInput{Username: c.Input.Username, VaultKey: hex.EncodeToString(key), Envelope: base64.StdEncoding.EncodeToString(env)},
			Expected: envelopeExpected{Doc: plain},
		})
	}
	conformance.Write(t, "envelope-go.json", "Go internal/client/crypto sealVault", envs)

	var wraps []conformance.Case[wrapGoInput, struct{}]
	for _, c := range conformance.Load[keysInput, keysExpected](t, "keys.json") {
		if c.Expected.WrappedVaultKey == "" {
			continue
		}
		k, err := deriveKeys(c.Input.Username, c.Input.Password, unhex(t, c.Input.SyncID), c.Input.Iterations)
		if err != nil {
			t.Fatal(err)
		}
		r := &detReader{seed: "wrap/" + c.Name}
		vk := make([]byte, KeySize)
		_, _ = r.Read(vk)
		wrapped, err := seal(r, k.KEK, wrapAAD(c.Input.Username), vk, nil)
		if err != nil {
			t.Fatal(err)
		}
		in := c.Input
		wraps = append(wraps, conformance.Case[wrapGoInput, struct{}]{Name: c.Name, Input: wrapGoInput{
			Username: in.Username, Password: in.Password, SyncID: in.SyncID, Iterations: in.Iterations,
			VaultKey: hex.EncodeToString(vk), WrappedVaultKey: hex.EncodeToString(wrapped),
		}})
	}
	conformance.Write(t, "wrap-go.json", "Go internal/client/crypto WrapVaultKey", wraps)
}
