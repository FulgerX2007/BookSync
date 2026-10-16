package vault

import (
	"maps"
	"slices"
	"unicode/utf16"
)

// Format is the vault document format this client reads and writes.
const Format = 1

// Kind of a vault node.
type Kind string

// Node kinds.
const (
	Folder   Kind = "folder"
	Bookmark Kind = "bookmark"
)

// The four roots use Firefox's fixed GUIDs (protocol §2).
const (
	RootToolbar GUID = "toolbar_____"
	RootMenu    GUID = "menu________"
	RootOther   GUID = "unfiled_____"
	RootMobile  GUID = "mobile______"
)

// Roots lists the roots in canonical order.
var Roots = []GUID{RootToolbar, RootMenu, RootOther, RootMobile}

var rootTitles = map[GUID]string{
	RootToolbar: "Bookmarks Toolbar",
	RootMenu:    "Bookmarks Menu",
	RootOther:   "Other Bookmarks",
	RootMobile:  "Mobile Bookmarks",
}

// IsRoot reports whether g is one of the four roots.
func IsRoot(g GUID) bool {
	_, ok := rootTitles[g]
	return ok
}

// RootTitle is the canonical (non-localized) title of a root.
func RootTitle(g GUID) string { return rootTitles[g] }

// Node is a folder or a bookmark. A bookmark always has a URL (possibly
// empty) and no children; a folder has children (possibly none) and no URL.
type Node struct {
	GUID     GUID
	Kind     Kind
	Title    string
	URL      string // bookmarks only
	Children []GUID // folders only, in display order
}

// Doc is the decrypted vault document (protocol §2).
type Doc struct {
	Format    int            `json:"format"`
	Seq       int64          `json:"seq"`
	WrittenBy string         `json:"writtenBy"`
	WrittenAt float64        `json:"writtenAt"` // ms since the epoch; TS accepts any number
	Nodes     map[GUID]*Node `json:"nodes"`
}

// NewEmpty returns a document holding only the four empty roots.
func NewEmpty() *Doc {
	d := &Doc{Format: Format, Nodes: make(map[GUID]*Node, len(Roots))}
	for _, r := range Roots {
		d.Nodes[r] = &Node{GUID: r, Kind: Folder, Title: rootTitles[r], Children: []GUID{}}
	}
	return d
}

// Clone returns a deep copy.
func (d *Doc) Clone() *Doc {
	c := *d
	c.Nodes = make(map[GUID]*Node, len(d.Nodes))
	for g, n := range d.Nodes {
		cn := *n
		cn.Children = slices.Clone(n.Children)
		c.Nodes[g] = &cn
	}
	return &c
}

// Parents maps every child GUID to its parent GUID.
func (d *Doc) Parents() map[GUID]GUID {
	p := make(map[GUID]GUID, len(d.Nodes))
	for _, g := range SortedGUIDs(d.Nodes) {
		for _, c := range d.Nodes[g].Children {
			p[c] = g
		}
	}
	return p
}

// CountNodes is the number of bookmarks and folders, roots not counted.
func (d *Doc) CountNodes() int {
	n := 0
	for g := range d.Nodes {
		if !IsRoot(g) {
			n++
		}
	}
	return n
}

// CompareGUID orders GUIDs as JavaScript's default sort does (by UTF-16
// code units), so Go and the extension iterate in the same order even for
// GUIDs outside ASCII.
func CompareGUID(a, b GUID) int {
	if isASCII(a) && isASCII(b) {
		switch {
		case a < b:
			return -1
		case a > b:
			return 1
		}
		return 0
	}
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
}

func isASCII(s string) bool {
	for i := range len(s) {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// SortGUIDs sorts in place with CompareGUID.
func SortGUIDs(gs []GUID) { slices.SortFunc(gs, CompareGUID) }

// SortedGUIDs returns the keys of m in CompareGUID order.
func SortedGUIDs[V any](m map[GUID]V) []GUID {
	gs := slices.Collect(maps.Keys(m))
	SortGUIDs(gs)
	return gs
}
