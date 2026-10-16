package vault

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/client/conformance"
)

type validateExpected struct {
	OK         bool      `json:"ok"`
	Error      string    `json:"error"`
	Violations *[]string `json:"violations"`
}

func TestParseConformance(t *testing.T) {
	for _, c := range conformance.Load[struct{ JSON string }, validateExpected](t, "validate.json") {
		t.Run(c.Name, func(t *testing.T) {
			d, err := Parse([]byte(c.Input.JSON))
			if c.Expected.OK {
				if err != nil {
					t.Fatalf("Parse: %v", err)
				}
				// Whatever Go accepts it must re-encode so that it parses again, equal.
				out, err := Marshal(d)
				if err != nil {
					t.Fatal(err)
				}
				again, err := Parse(out)
				if err != nil || !Equal(d, again) || again.Seq != d.Seq || again.WrittenAt != d.WrittenAt {
					t.Fatalf("re-encoded document does not round-trip: %v\n%s", err, out)
				}
				return
			}
			if CodeOf(err) != c.Expected.Error {
				t.Fatalf("Parse err = %v, want %s", err, c.Expected.Error)
			}
			if c.Expected.Violations == nil {
				return
			}
			// Tree-level failures: compare the full violation list.
			var loose looseDoc
			if err := json.Unmarshal([]byte(c.Input.JSON), &loose); err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, v := range Validate(loose.doc()) {
				got = append(got, string(v.Kind)+":"+v.GUID)
			}
			slices.Sort(got)
			if !slices.Equal(got, *c.Expected.Violations) {
				t.Fatalf("violations = %v, want %v", got, *c.Expected.Violations)
			}
		})
	}
}

// looseDoc decodes a tree without Parse's checks, for Validate tests.
type looseDoc struct {
	Nodes map[GUID]struct {
		GUID     GUID    `json:"guid"`
		Kind     Kind    `json:"kind"`
		Title    string  `json:"title"`
		URL      *string `json:"url"`
		Children []GUID  `json:"children"`
	} `json:"nodes"`
}

func (l looseDoc) doc() *Doc {
	d := &Doc{Format: Format, Nodes: map[GUID]*Node{}}
	for k, n := range l.Nodes {
		node := &Node{GUID: n.GUID, Kind: n.Kind, Title: n.Title, Children: n.Children}
		if n.URL != nil {
			node.URL = *n.URL
		}
		d.Nodes[k] = node
	}
	return d
}

type equalInput struct {
	A, B json.RawMessage
}

type equalExpected struct {
	Equal bool    `json:"equal"`
	Diff  Changes `json:"diff"`
}

func mustParse(t testing.TB, raw []byte) *Doc {
	t.Helper()
	d, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse: %v\n%s", err, raw)
	}
	return d
}

func TestEqualConformance(t *testing.T) {
	for _, c := range conformance.Load[equalInput, equalExpected](t, "equal.json") {
		t.Run(c.Name, func(t *testing.T) {
			a, b := mustParse(t, c.Input.A), mustParse(t, c.Input.B)
			if got := Equal(a, b); got != c.Expected.Equal {
				t.Errorf("Equal = %v", got)
			}
			if got := DiffStats(a, b); got != c.Expected.Diff {
				t.Errorf("DiffStats = %+v, want %+v", got, c.Expected.Diff)
			}
		})
	}
}

// Every document in the merge corpus survives Parse → Marshal → JSON equality,
// so Go writes vaults byte-for-byte compatible in structure with TS.
func TestMarshalMatchesTS(t *testing.T) {
	type in struct{ Base, Local, Remote json.RawMessage }
	type exp struct{ Merged json.RawMessage }
	for _, c := range conformance.Load[in, exp](t, "merge3.json") {
		for _, raw := range []json.RawMessage{c.Input.Base, c.Input.Local, c.Input.Remote, c.Expected.Merged} {
			out, err := Marshal(mustParse(t, raw))
			if err != nil {
				t.Fatal(err)
			}
			var x, y any
			_ = json.Unmarshal(raw, &x)
			_ = json.Unmarshal(out, &y)
			if !reflect.DeepEqual(x, y) {
				t.Fatalf("%s: Go encoding differs:\nTS %s\nGo %s", c.Name, raw, out)
			}
		}
	}
}

func TestMarshalPresenceRules(t *testing.T) {
	d := toolbar(f("empty"), b("e").withURL(""), b("x").withTitle(`<a href="x">&</a>`))
	d.Nodes["empty"].Children = nil // a nil slice must still encode as []
	out, err := Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{
		`"empty":{"guid":"empty","kind":"folder","title":"empty","children":[]}`,
		`"e":{"guid":"e","kind":"bookmark","title":"e","url":""}`,
		`<a href=\"x\">&</a>`,
	} {
		if !strings.Contains(s, want) {
			t.Errorf("encoding lacks %s:\n%s", want, s)
		}
	}
	if strings.Contains(s, "null") {
		t.Errorf("encoding contains null:\n%s", s)
	}
}

func TestNodeUnmarshalJSON(t *testing.T) {
	var n Node
	if err := json.Unmarshal([]byte(`{"guid":"a","kind":"bookmark","title":"t","url":"u","children":["x"],"extra":1}`), &n); err != nil {
		t.Fatal(err)
	}
	if n.Kind != Bookmark || n.URL != "u" || n.Children != nil {
		t.Fatalf("node = %+v", n)
	}
	for _, bad := range []string{`{"guid":"a","kind":"bookmark","title":"t"}`, `{"kind":"folder","title":"t","children":[]}`, `[]`, `{`} {
		if err := json.Unmarshal([]byte(bad), &n); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	var d Doc
	raw, _ := Marshal(toolbar(f("f", b("a"))))
	if err := json.Unmarshal(raw, &d); err != nil || !Equal(&d, toolbar(f("f", b("a")))) {
		t.Fatalf("Doc round trip: %v", err)
	}
}

func TestParseRejectsInvalidUTF8AndTrailingData(t *testing.T) {
	valid, _ := Marshal(NewEmpty())
	for name, in := range map[string][]byte{
		"invalid UTF-8": append([]byte(`{"x":"`+"\xff"+`"}`), valid...),
		"trailing data": append(append([]byte{}, valid...), []byte(" {}")...),
		"empty":         nil,
	} {
		if _, err := Parse(in); CodeOf(err) != CodeBadFormat {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if _, err := Parse([]byte(`{"format":1e400}`)); CodeOf(err) != CodeUnsupportedFormat {
		t.Errorf("format 1e400: err = %v, want unsupported_format as in JS (Infinity > 1)", err)
	}
	if _, err := Parse([]byte(`{"format":1,"seq":9007199254740992,"writtenBy":"","writtenAt":0,"nodes":{}}`)); CodeOf(err) != CodeBadFormat {
		t.Errorf("unsafe seq accepted: %v", err)
	}
	if !strings.HasPrefix((&Error{Message: "m"}).Error(), "vault: ") {
		t.Error("Error()")
	}
}

func TestValidateGoConstructedNodes(t *testing.T) {
	d := toolbar(b("a"), f("f"))
	d.Nodes["a"].Children = []GUID{}
	d.Nodes["f"].URL = "https://f/"
	d.Nodes["k"] = &Node{GUID: "k", Kind: "separator"}
	d.Nodes[RootToolbar].Children = append(d.Nodes[RootToolbar].Children, "k")
	got := map[ViolationKind]bool{}
	for _, v := range Validate(d) {
		got[v.Kind] = true
	}
	if !got[BadBookmark] || !got[BadFolder] {
		t.Fatalf("violations = %v", got)
	}
	if len(Validate(toolbar(b("a"), f("f", b("c"))))) != 0 {
		t.Fatal("valid tree reported invalid")
	}
}

func TestCompareGUIDMatchesJavaScript(t *testing.T) {
	// JS sorts by UTF-16 code units: U+FF5E (one unit 0xFF5E) sorts after
	// U+1F600 (surrogates 0xD83D…), the reverse of UTF-8 byte order.
	gs := []GUID{"\uff5e", "\U0001F600", "b", "B", "a_", "a-"}
	SortGUIDs(gs)
	want := []GUID{"B", "a-", "a_", "b", "\U0001F600", "\uff5e"}
	if !slices.Equal(gs, want) {
		t.Fatalf("sorted = %q, want %q", gs, want)
	}
	if CompareGUID("a", "a") != 0 || CompareGUID("a", "b") != -1 || CompareGUID("b", "a") != 1 {
		t.Fatal("ASCII comparisons")
	}
}

func TestDocHelpers(t *testing.T) {
	d := toolbar(f("f", b("a")), b("c"))
	if d.CountNodes() != 3 {
		t.Errorf("CountNodes = %d", d.CountNodes())
	}
	if p := d.Parents(); p["a"] != "f" || p["f"] != RootToolbar {
		t.Errorf("Parents = %v", p)
	}
	c := d.Clone()
	c.Nodes["f"].Children[0] = "zz"
	c.Nodes["c"].Title = "changed"
	if d.Nodes["f"].Children[0] != "a" || d.Nodes["c"].Title != "c" {
		t.Error("Clone shares state")
	}
	if !IsRoot(RootMobile) || IsRoot("a") || RootTitle(RootMenu) != "Bookmarks Menu" {
		t.Error("roots")
	}
}
