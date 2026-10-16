package merge

import (
	"encoding/json"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/client/conformance"
	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

type mergeInput struct{ Base, Local, Remote json.RawMessage }

type mergeExpected struct {
	Merged json.RawMessage `json:"merged"`
	Stats  Stats           `json:"stats"`
}

func parse(t testing.TB, raw []byte) *vault.Doc {
	t.Helper()
	d, err := vault.Parse(raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return d
}

// TestMerge3Conformance replays every case the TS merge3 computed: the
// merged tree, its header, root titles and the stats must all match.
func TestMerge3Conformance(t *testing.T) {
	for _, c := range conformance.Load[mergeInput, mergeExpected](t, "merge3.json") {
		t.Run(c.Name, func(t *testing.T) {
			got, stats := Merge3(parse(t, c.Input.Base), parse(t, c.Input.Local), parse(t, c.Input.Remote))
			want := parse(t, c.Expected.Merged)
			if !vault.Equal(got, want) || got.Seq != want.Seq || got.WrittenBy != want.WrittenBy || got.WrittenAt != want.WrittenAt {
				gj, _ := vault.Marshal(got)
				t.Fatalf("merged differs:\nGo %s\nTS %s", gj, c.Expected.Merged)
			}
			for _, r := range vault.Roots {
				if got.Nodes[r].Title != want.Nodes[r].Title {
					t.Fatalf("root %s title = %q, want %q", r, got.Nodes[r].Title, want.Nodes[r].Title)
				}
			}
			if stats != c.Expected.Stats {
				t.Fatalf("stats = %+v, want %+v", stats, c.Expected.Stats)
			}
		})
	}
}

// Readable spot checks of the §4.4 table, independent of the corpus.
func TestMerge3Rules(t *testing.T) {
	tb := func(specs ...spec) *vault.Doc { return toolbar(specs...) }
	tests := []struct {
		name                      string
		base, local, remote, want *vault.Doc
		conflicts                 int
	}{
		{"adds on both sides, local after its predecessor", tb(b("a")), tb(b("a"), b("x")), tb(b("a"), b("y")), tb(b("a"), b("x"), b("y")), 0},
		{"true conflict: remote wins", tb(b("a")), tb(b("a").title("L")), tb(b("a").title("R")), tb(b("a").title("R")), 1},
		{"edit beats delete", tb(b("a"), b("b")), tb(b("a").title("e"), b("b")), tb(b("b")), tb(b("a").title("e"), b("b")), 0},
		{"Dogear re-homing", tb(b("a"), f("f", b("x"))), tb(b("a"), f("f", b("x"), b("c"))), tb(b("a")), tb(b("a"), b("c")), 0},
		{"cycle resolves to remote parent", tb(f("f"), f("g")), tb(f("g", f("f"))), tb(f("f", f("g"))), tb(f("f", f("g"))), 0},
		{"both reordered: remote order", tb(b("a"), b("b"), b("c")), tb(b("c"), b("b"), b("a")), tb(b("b"), b("a"), b("c")), tb(b("b"), b("a"), b("c")), 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, stats := Merge3(tt.base, tt.local, tt.remote)
			if !vault.Equal(got, tt.want) {
				gj, _ := vault.Marshal(got)
				t.Fatalf("merged = %s", gj)
			}
			if stats.Conflicts != tt.conflicts {
				t.Fatalf("conflicts = %d, want %d", stats.Conflicts, tt.conflicts)
			}
		})
	}
}

func TestMerge3NeverAltersRoots(t *testing.T) {
	base := toolbar(b("a"))
	local := base.Clone()
	local.Nodes[vault.RootToolbar].Title = "Lesezeichenleiste"
	got, _ := Merge3(base, local, base)
	if got.Nodes[vault.RootToolbar].Title != "Bookmarks Toolbar" {
		t.Fatalf("root title = %q", got.Nodes[vault.RootToolbar].Title)
	}
}

// --- compact builders (as in the vault package tests) ---

type spec struct {
	g      vault.GUID
	folder bool
	t      *string
	kids   []spec
}

func b(g vault.GUID) spec               { return spec{g: g} }
func f(g vault.GUID, kids ...spec) spec { return spec{g: g, folder: true, kids: kids} }
func (s spec) title(t string) spec      { s.t = &t; return s }

func toolbar(specs ...spec) *vault.Doc {
	d := vault.NewEmpty()
	var add func(parent vault.GUID, specs []spec)
	add = func(parent vault.GUID, specs []spec) {
		for _, s := range specs {
			n := &vault.Node{GUID: s.g, Title: s.g, Kind: vault.Bookmark, URL: "https://" + s.g + ".example/"}
			if s.t != nil {
				n.Title = *s.t
			}
			if s.folder {
				n.Kind, n.URL, n.Children = vault.Folder, "", []vault.GUID{}
			}
			d.Nodes[s.g] = n
			d.Nodes[parent].Children = append(d.Nodes[parent].Children, s.g)
			add(s.g, s.kids)
		}
	}
	add(vault.RootToolbar, specs)
	return d
}
