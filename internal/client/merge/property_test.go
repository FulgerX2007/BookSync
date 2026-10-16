package merge

import (
	"math/rand/v2"
	"reflect"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

// Ports of merge.property.test.ts.
func TestMerge3Properties(t *testing.T) {
	r := rand.New(rand.NewPCG(20261016, 3))
	for i := range propRuns(t) {
		s := randScenario(r)
		m, stats := Merge3(s.base, s.local, s.remote)

		if vs := vault.Validate(m); len(vs) > 0 {
			t.Fatalf("run %d: invalid merge result: %v", i, vs)
		}
		m2, stats2 := Merge3(s.base.Clone(), s.local.Clone(), s.remote.Clone())
		if !reflect.DeepEqual(m, m2) || stats != stats2 {
			t.Fatalf("run %d: not deterministic", i)
		}
		if got, _ := Merge3(s.base, s.local, s.base); !vault.Equal(got, s.local) {
			t.Fatalf("run %d: remote did nothing, but local changed", i)
		}
		if got, _ := Merge3(s.base, s.base, s.remote); !vault.Equal(got, s.remote) {
			t.Fatalf("run %d: local did nothing, but remote changed", i)
		}
		if got, _ := Merge3(s.base, s.local, s.local); !vault.Equal(got, s.local) {
			t.Fatalf("run %d: same edits on both sides changed", i)
		}
		for _, side := range []*vault.Doc{s.local, s.remote} {
			for _, g := range editedOrAdded(s.base, side) {
				if m.Nodes[g] == nil {
					t.Fatalf("run %d: lost %s, edited or added on one side", i, g)
				}
			}
		}
		// Stable: re-merging the result changes nothing.
		if got, _ := Merge3(s.remote, s.remote, m); !vault.Equal(got, m) {
			t.Fatalf("run %d: remote device re-merge not stable", i)
		}
		if got, _ := Merge3(m, m, m); !vault.Equal(got, m) {
			t.Fatalf("run %d: self merge not stable", i)
		}
		for _, root := range vault.Roots {
			if m.Nodes[root] == nil || m.Nodes[root].Title != vault.RootTitle(root) {
				t.Fatalf("run %d: root %s altered", i, root)
			}
		}
	}
}

func editedOrAdded(base, side *vault.Doc) []vault.GUID {
	pb, ps := base.Parents(), side.Parents()
	var out []vault.GUID
	for g, n := range side.Nodes {
		if vault.IsRoot(g) {
			continue
		}
		b := base.Nodes[g]
		if b == nil || b.Title != n.Title || b.URL != n.URL || pb[g] != ps[g] {
			out = append(out, g)
		}
	}
	return out
}
