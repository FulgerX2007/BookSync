package crypto

import (
	"crypto/rand"
	"math/big"
	"strings"
	"unicode"
)

// SyncID display format (protocol §1.5): BS1-XXXX-…, 26 Crockford base32 data
// characters and 2 check characters (value mod 1021).
const (
	SyncIDSize  = 16
	syncPrefix  = "BS1"
	alphabet    = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" // Crockford: no I, L, O, U
	dataChars   = 26
	checkChars  = 2
	checkModulo = 1021 // prime: catches any substitution or adjacent swap
)

// NewSyncID returns 16 random bytes.
func NewSyncID() []byte {
	b := make([]byte, SyncIDSize)
	_, _ = rand.Read(b) // crypto/rand.Read never fails on supported platforms
	return b
}

func encode32(v *big.Int, chars int) string {
	out := make([]byte, chars)
	x := new(big.Int).Set(v)
	mask := big.NewInt(31)
	d := new(big.Int)
	for i := chars - 1; i >= 0; i-- {
		out[i] = alphabet[d.And(x, mask).Int64()]
		x.Rsh(x, 5)
	}
	return string(out)
}

// FormatSyncID renders a SyncID for people.
func FormatSyncID(id []byte) (string, error) {
	if len(id) != SyncIDSize {
		return "", newError(CodeInvalidFormat, "SyncID must be 16 bytes")
	}
	v := new(big.Int).SetBytes(id)
	body := encode32(v, dataChars) + encode32(new(big.Int).Mod(v, big.NewInt(checkModulo)), checkChars)
	groups := []string{syncPrefix}
	for i := 0; i < len(body); i += 4 {
		groups = append(groups, body[i:min(i+4, len(body))])
	}
	return strings.Join(groups, "-"), nil
}

// ParseSyncID reads a SyncID as typed by a person: case, spaces and dashes
// don't matter, I/L read as 1 and O as 0, and the BS1 prefix is optional.
func ParseSyncID(input string) ([]byte, error) {
	var sb strings.Builder
	for _, r := range strings.ToUpper(input) {
		switch {
		case r == '-' || unicode.IsSpace(r) || r == '\uFEFF':
			continue
		case r == 'I' || r == 'L':
			sb.WriteByte('1')
		case r == 'O':
			sb.WriteByte('0')
		default:
			sb.WriteRune(r)
		}
	}
	// Unambiguous: a valid body starts with 0-3 (128 bits in 130), never "B".
	s := strings.TrimPrefix(sb.String(), syncPrefix)
	if len([]rune(s)) != dataChars+checkChars {
		return nil, newError(CodeInvalidFormat, "SyncID must have 28 characters after the BS1 prefix")
	}
	v, check := new(big.Int), new(big.Int)
	for i, r := range s {
		d := strings.IndexRune(alphabet, r)
		if d < 0 {
			return nil, newError(CodeInvalidFormat, "SyncID contains an invalid character")
		}
		acc := v
		if i >= dataChars {
			acc = check
		}
		acc.Lsh(acc, 5).Or(acc, big.NewInt(int64(d)))
	}
	if v.BitLen() > 8*SyncIDSize || new(big.Int).Mod(v, big.NewInt(checkModulo)).Cmp(check) != 0 {
		return nil, newError(CodeInvalidChecksum, "SyncID has a typo")
	}
	return v.FillBytes(make([]byte, SyncIDSize)), nil
}
