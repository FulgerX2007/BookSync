package vault

import "slices"

// Equal reports structural equality: the same nodes with the same kind,
// title, URL and child order. Header fields (seq, writer) and root titles,
// which are localized per browser, are ignored (treesEqual in the extension).
func Equal(a, b *Doc) bool {
	if len(a.Nodes) != len(b.Nodes) {
		return false
	}
	for g, x := range a.Nodes {
		y := b.Nodes[g]
		if y == nil || !NodesEqual(x, y, IsRoot(g)) {
			return false
		}
	}
	return true
}

// NodesEqual compares two nodes; ignoreTitle is used for roots.
func NodesEqual(x, y *Node, ignoreTitle bool) bool {
	if x.Kind != y.Kind || x.URL != y.URL {
		return false
	}
	if !ignoreTitle && x.Title != y.Title {
		return false
	}
	return slices.Equal(x.Children, y.Children)
}

// Changes counts what turns one tree into another.
type Changes struct {
	Adds    int `json:"adds"`
	Updates int `json:"updates"`
	Moves   int `json:"moves"`
	Deletes int `json:"deletes"`
}

// DiffStats counts the changes that turn from into to (diffStats in the
// extension). A kind change counts as an update, as there a folder's missing
// url never equals a bookmark's url.
func DiffStats(from, to *Doc) Changes {
	var c Changes
	pFrom, pTo := from.Parents(), to.Parents()
	for g, n := range to.Nodes {
		if IsRoot(g) {
			continue
		}
		o := from.Nodes[g]
		if o == nil {
			c.Adds++
			continue
		}
		if o.Title != n.Title || o.Kind != n.Kind || o.URL != n.URL {
			c.Updates++
		}
		if pFrom[g] != pTo[g] {
			c.Moves++
		}
	}
	for g := range from.Nodes {
		if !IsRoot(g) && to.Nodes[g] == nil {
			c.Deletes++
		}
	}
	return c
}
