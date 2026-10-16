package vault

import (
	"regexp"
	"testing"
)

var guidRE = regexp.MustCompile(`^[A-Za-z0-9_-]{12}$`)

func TestNewGUID(t *testing.T) {
	seen := make(map[GUID]bool)
	for range 10000 {
		g := NewGUID()
		if !guidRE.MatchString(g) {
			t.Fatalf("NewGUID() = %q, want 12 base64url characters", g)
		}
		if seen[g] {
			t.Fatalf("NewGUID() repeated %q", g)
		}
		seen[g] = true
	}
}
