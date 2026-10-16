package merge

import (
	"fmt"
	"math/rand/v2"
	"os"
	"strconv"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

// propRuns is the property-test iteration count (BOOKSYNC_PROP_RUNS, the
// analogue of the extension's FC_RUNS).
func propRuns(t testing.TB) int {
	t.Helper()
	if s := os.Getenv("BOOKSYNC_PROP_RUNS"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil {
			t.Fatalf("BOOKSYNC_PROP_RUNS: %v", err)
		}
		return n
	}
	return 200
}

// edit mirrors Edit in extension/test/arbitraries.ts. Picks are raw numbers,
// reduced modulo the candidate count when applied, so any script is valid
// against any tree.
type edit struct {
	op                    string
	parent, index, target int
	title, url            int
}

// randEdit draws an edit with arbEdit's weights (3,2,2,1,3,2) and small
// title/url domains, so both sides often collide.
func randEdit(r *rand.Rand, addsOnly bool) edit {
	pick := func() int { return r.IntN(1001) }
	ops := []struct {
		op string
		w  int
	}{{"addBookmark", 3}, {"addFolder", 2}, {"rename", 2}, {"reurl", 1}, {"move", 3}, {"delete", 2}}
	if addsOnly {
		ops = ops[:2]
	}
	total := 0
	for _, o := range ops {
		total += o.w
	}
	n := r.IntN(total)
	op := ops[0].op
	for _, o := range ops {
		if n < o.w {
			op = o.op
			break
		}
		n -= o.w
	}
	return edit{op: op, parent: pick(), index: pick(), target: pick(), title: r.IntN(6), url: r.IntN(6)}
}

func randEdits(r *rand.Rand, max int, addsOnly bool) []edit {
	es := make([]edit, r.IntN(max+1))
	for i := range es {
		es[i] = randEdit(r, addsOnly)
	}
	return es
}

// randTree is arbTree: random additions to an empty doc.
func randTree(r *rand.Rand) *vault.Doc {
	return applyEdits(vault.NewEmpty(), randEdits(r, 40, true), "b")
}

func folders(d *vault.Doc) []vault.GUID {
	var out []vault.GUID
	for _, g := range vault.SortedGUIDs(d.Nodes) {
		if d.Nodes[g].Kind == vault.Folder {
			out = append(out, g)
		}
	}
	return out
}

func nonRoots(d *vault.Doc) []vault.GUID {
	var out []vault.GUID
	for _, g := range vault.SortedGUIDs(d.Nodes) {
		if !vault.IsRoot(g) {
			out = append(out, g)
		}
	}
	return out
}

func isDescendant(d *vault.Doc, node, maybeAncestor vault.GUID) bool {
	p := d.Parents()
	for g, ok := node, true; ok; g, ok = p[g] {
		if g == maybeAncestor {
			return true
		}
	}
	return false
}

func detach(d *vault.Doc, g vault.GUID) {
	if parent, ok := d.Parents()[g]; ok {
		kids := d.Nodes[parent].Children
		out := kids[:0:0]
		for _, c := range kids {
			if c != g {
				out = append(out, c)
			}
		}
		d.Nodes[parent].Children = out
	}
}

func insert(d *vault.Doc, parent, g vault.GUID, index int) {
	kids := d.Nodes[parent].Children
	i := index % (len(kids) + 1)
	d.Nodes[parent].Children = append(kids[:i:i], append([]vault.GUID{g}, kids[i:]...)...)
}

func removeSubtree(d *vault.Doc, g vault.GUID) {
	if n := d.Nodes[g]; n != nil {
		for _, c := range n.Children {
			removeSubtree(d, c)
		}
	}
	delete(d.Nodes, g)
}

// applyEdits is a line-by-line port of applyEdits in arbitraries.ts: new
// nodes get GUIDs prefix1, prefix2, … so two sides never collide.
func applyEdits(doc *vault.Doc, edits []edit, prefix string) *vault.Doc {
	d := doc.Clone()
	next := 1
	for _, e := range edits {
		switch e.op {
		case "addBookmark", "addFolder":
			fs := folders(d)
			parent := fs[e.parent%len(fs)]
			g := fmt.Sprintf("%s%d", prefix, next)
			next++
			if e.op == "addBookmark" {
				d.Nodes[g] = &vault.Node{GUID: g, Kind: vault.Bookmark, Title: fmt.Sprintf("t%d", e.title), URL: fmt.Sprintf("https://u%d.example/", e.url)}
			} else {
				d.Nodes[g] = &vault.Node{GUID: g, Kind: vault.Folder, Title: fmt.Sprintf("t%d", e.title), Children: []vault.GUID{}}
			}
			insert(d, parent, g, e.index)
		default:
			ns := nonRoots(d)
			if len(ns) == 0 {
				continue
			}
			g := ns[e.target%len(ns)]
			node := d.Nodes[g]
			switch e.op {
			case "rename":
				node.Title = fmt.Sprintf("t%d", e.title)
			case "reurl":
				if node.Kind == vault.Bookmark {
					node.URL = fmt.Sprintf("https://u%d.example/", e.url)
				}
			case "delete":
				detach(d, g)
				removeSubtree(d, g)
			case "move":
				var candidates []vault.GUID
				for _, f := range folders(d) {
					if !isDescendant(d, f, g) {
						candidates = append(candidates, f)
					}
				}
				parent := candidates[e.parent%len(candidates)]
				detach(d, g)
				insert(d, parent, g, e.index)
			}
		}
	}
	return d
}

type scenario struct{ base, local, remote *vault.Doc }

func randScenario(r *rand.Rand) scenario {
	base := randTree(r)
	return scenario{base, applyEdits(base, randEdits(r, 15, false), "l"), applyEdits(base, randEdits(r, 15, false), "r")}
}

func TestApplyEditsKeepsTreesValid(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for range propRuns(t) {
		s := randScenario(r)
		for _, d := range []*vault.Doc{s.base, s.local, s.remote} {
			if vs := vault.Validate(d); len(vs) > 0 {
				t.Fatalf("generator produced an invalid tree: %v", vs)
			}
		}
	}
}
