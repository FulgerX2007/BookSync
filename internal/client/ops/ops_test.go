package ops

import (
	"slices"
	"strings"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

const T = vault.RootToolbar

// fixture: toolbar [a, f[c, g[]], d]
func fixture() *vault.Doc {
	d := vault.NewEmpty()
	add := func(parent vault.GUID, n *vault.Node) {
		d.Nodes[n.GUID] = n
		d.Nodes[parent].Children = append(d.Nodes[parent].Children, n.GUID)
	}
	bm := func(g vault.GUID) *vault.Node {
		return &vault.Node{GUID: g, Kind: vault.Bookmark, Title: g, URL: "https://" + g + ".example/"}
	}
	fo := func(g vault.GUID) *vault.Node {
		return &vault.Node{GUID: g, Kind: vault.Folder, Title: g, Children: []vault.GUID{}}
	}
	add(T, bm("a"))
	add(T, fo("f"))
	add("f", bm("c"))
	add("f", fo("g"))
	add(T, bm("d"))
	return d
}

func valid(t *testing.T, d *vault.Doc) {
	t.Helper()
	if vs := vault.Validate(d); len(vs) > 0 {
		t.Fatalf("invalid tree: %v", vs)
	}
}

func kids(d *vault.Doc, g vault.GUID) []vault.GUID { return d.Nodes[g].Children }

func TestAddPositions(t *testing.T) {
	tests := []struct {
		name string
		pos  Position
		at   int
	}{
		{"first", First, 0},
		{"after a", After("a"), 1},
		{"after last", After("d"), 3},
		{"end", End, 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := fixture()
			g, err := AddBookmark(d, T, tt.pos, "New", "  https://new.example/  ")
			if err != nil {
				t.Fatal(err)
			}
			valid(t, d)
			if kids(d, T)[tt.at] != g || d.Nodes[g].URL != "https://new.example/" || d.Nodes[g].Title != "New" || len(g) != 12 {
				t.Fatalf("children = %v, node = %+v", kids(d, T), d.Nodes[g])
			}
		})
	}
	d := fixture()
	g, err := AddFolder(d, "f", End, "")
	if err != nil || d.Nodes[g].Kind != vault.Folder || kids(d, "f")[2] != g {
		t.Fatalf("AddFolder: %v", err)
	}
	valid(t, d)
}

func TestAddErrors(t *testing.T) {
	tests := []struct {
		name   string
		parent vault.GUID
		pos    Position
		url    string
		code   string
	}{
		{"unknown parent", "zz", End, "https://x/", CodeStale},
		{"parent is a bookmark", "a", End, "https://x/", CodeNotFolder},
		{"anchor not in parent", T, After("c"), "https://x/", CodeStale},
		{"relative url", T, End, "example.com", CodeInvalidURL},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := fixture()
			if _, err := AddBookmark(d, tt.parent, tt.pos, "x", tt.url); CodeOf(err) != tt.code {
				t.Fatalf("err = %v, want %s", err, tt.code)
			}
			if len(d.Nodes) != len(fixture().Nodes) {
				t.Fatal("a failed add changed the tree")
			}
		})
	}
}

func TestRenameAndSetURL(t *testing.T) {
	d := fixture()
	if err := Rename(d, "f", ""); err != nil || d.Nodes["f"].Title != "" {
		t.Fatalf("Rename: %v", err)
	}
	if err := SetURL(d, "a", " javascript:void(0) "); err != nil || d.Nodes["a"].URL != "javascript:void(0)" {
		t.Fatalf("SetURL: %v", err)
	}
	for name, err := range map[string]error{
		"rename root":   Rename(d, T, "x"),
		"set url root":  SetURL(d, vault.RootMobile, "https://x/"),
		"rename gone":   Rename(d, "zz", "x"),
		"url on folder": SetURL(d, "f", "https://x/"),
		"bad url":       SetURL(d, "a", "not a url"),
	} {
		want := map[string]string{"rename root": CodeRootLocked, "set url root": CodeRootLocked, "rename gone": CodeStale, "url on folder": CodeNotBookmark, "bad url": CodeInvalidURL}[name]
		if CodeOf(err) != want {
			t.Errorf("%s: err = %v, want %s", name, err, want)
		}
	}
}

func TestMove(t *testing.T) {
	tests := []struct {
		name        string
		g, parent   vault.GUID
		pos         Position
		wantParent  []vault.GUID
		wantToolbar []vault.GUID
	}{
		{"into folder, first", "a", "f", First, []vault.GUID{"a", "c", "g"}, []vault.GUID{"f", "d"}},
		{"into folder, after c", "d", "f", After("c"), []vault.GUID{"c", "d", "g"}, []vault.GUID{"a", "f"}},
		{"within parent, down", "a", T, After("d"), nil, []vault.GUID{"f", "d", "a"}},
		{"within parent, up", "d", T, First, nil, []vault.GUID{"d", "a", "f"}},
		{"after itself is a no-op", "a", T, After("a"), nil, []vault.GUID{"a", "f", "d"}},
		{"folder to end of other root", "f", vault.RootOther, End, nil, []vault.GUID{"a", "d"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := fixture()
			if err := Move(d, tt.g, tt.parent, tt.pos); err != nil {
				t.Fatal(err)
			}
			valid(t, d)
			if tt.wantParent != nil && !slices.Equal(kids(d, tt.parent), tt.wantParent) {
				t.Errorf("%s children = %v", tt.parent, kids(d, tt.parent))
			}
			if !slices.Equal(kids(d, T), tt.wantToolbar) {
				t.Errorf("toolbar = %v", kids(d, T))
			}
		})
	}
}

func TestMoveErrors(t *testing.T) {
	tests := []struct {
		name      string
		g, parent vault.GUID
		pos       Position
		code      string
	}{
		{"root", T, vault.RootOther, End, CodeRootLocked},
		{"into itself", "f", "f", End, CodeInvalidMove},
		{"into own subtree", "f", "g", End, CodeInvalidMove},
		{"into a bookmark", "a", "d", End, CodeNotFolder},
		{"unknown node", "zz", T, End, CodeStale},
		{"unknown parent", "a", "zz", End, CodeStale},
		{"anchor elsewhere", "a", T, After("c"), CodeStale},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := fixture()
			if err := Move(d, tt.g, tt.parent, tt.pos); CodeOf(err) != tt.code {
				t.Fatalf("err = %v, want %s", err, tt.code)
			}
			if !vault.Equal(d, fixture()) {
				t.Fatal("a failed move changed the tree")
			}
		})
	}
}

func TestDelete(t *testing.T) {
	d := fixture()
	if b, f := CountSubtree(d, "f"); b != 1 || f != 1 {
		t.Fatalf("CountSubtree = %d, %d", b, f)
	}
	if b, f := CountSubtree(d, "zz"); b != 0 || f != 0 {
		t.Fatal("CountSubtree of a missing node")
	}
	if err := Delete(d, "f"); err != nil {
		t.Fatal(err)
	}
	valid(t, d)
	if d.Nodes["c"] != nil || d.Nodes["g"] != nil || !slices.Equal(kids(d, T), []vault.GUID{"a", "d"}) {
		t.Fatalf("after delete: %v", kids(d, T))
	}
	if CodeOf(Delete(d, vault.RootMenu)) != CodeRootLocked || CodeOf(Delete(d, "f")) != CodeStale {
		t.Fatal("delete errors")
	}
}

func TestParseURL(t *testing.T) {
	ok := []string{"https://example.com/", " http://localhost:8080/x ", "javascript:alert(1)", "mailto:a@b.c", "file:///tmp/x", "about:blank", "chrome://settings", "HTTPS://Example.COM"}
	bad := []string{"", "example.com", "/relative", "http://", "https:///path", "https://exa mple.com/", "1http://x", "://x"}
	for _, s := range ok {
		if got, err := ParseURL(s); err != nil || got != strings.TrimSpace(s) {
			t.Errorf("ParseURL(%q) = %q, %v", s, got, err)
		}
	}
	for _, s := range bad {
		if _, err := ParseURL(s); CodeOf(err) != CodeInvalidURL {
			t.Errorf("ParseURL(%q) accepted", s)
		}
	}
	if !strings.HasPrefix((&Error{Message: "m"}).Error(), "ops: ") {
		t.Error("Error()")
	}
}
