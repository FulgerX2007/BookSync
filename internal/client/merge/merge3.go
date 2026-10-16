// Package merge is the three-way bookmark merge of docs/protocol.md §4.4 and
// the mass-deletion guard of §4.6. It is a function-by-function port of
// extension/src/sync/merge.ts and guard.ts; every device must compute the
// same result from the same inputs, which the golden corpus verifies.
package merge

import (
	"slices"

	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

type guid = vault.GUID

// Stats summarizes a merge (MergeStats in the extension).
type Stats struct {
	// ToLocal is what applying the result does to this device.
	ToLocal vault.Changes `json:"toLocal"`
	// ToRemote is what uploading the result does to the server's tree.
	ToRemote vault.Changes `json:"toRemote"`
	// Conflicts counts true conflicts resolved in favour of the remote side.
	Conflicts int `json:"conflicts"`
}

// opt is a GUID that may be absent, compared like a JS `Guid | undefined`.
type opt struct {
	g  guid
	ok bool
}

var none = opt{}

func some(g guid) opt { return opt{g, true} }

type parents map[guid]guid

func (p parents) get(g guid) opt {
	if v, ok := p[g]; ok {
		return some(v)
	}
	return none
}

type side int

const (
	sideLocal side = iota
	sideRemote
)

type decision struct {
	node   vault.Node
	parent opt
	// side is whose parent chain to walk if the parent does not survive.
	side side
}

// Merge3 merges base (last synced), local (this device now) and remote (the
// server's vault). It is pure and deterministic.
//
//   - a change made on one side only wins;
//   - an edit beats a delete (edit = title, url or parent change);
//   - on a true conflict the remote side (already committed) wins;
//   - children of a deleted folder that survive move to the nearest
//     surviving ancestor;
//   - cycles created by crossing moves are broken with the remote parent;
//   - roots are never added, removed, moved or renamed.
func Merge3(base, local, remote *vault.Doc) (*vault.Doc, Stats) {
	pB, pL, pR := parents(base.Parents()), parents(local.Parents()), parents(remote.Parents())
	conflicts := 0

	// pick is the three-way choice of one value; it counts true conflicts.
	pick := func(hasBase bool, b, l, r string) string {
		if l == r {
			return l
		}
		if hasBase && l == b {
			return r
		}
		if hasBase && r == b {
			return l
		}
		conflicts++
		return r
	}

	// 1. Decide which nodes survive, with which fields and parent.
	decisions := make(map[guid]*decision)
	all := make(map[guid]struct{})
	for _, d := range []*vault.Doc{base, local, remote} {
		for g := range d.Nodes {
			all[g] = struct{}{}
		}
	}
	for _, g := range vault.SortedGUIDs(all) {
		if vault.IsRoot(g) {
			continue
		}
		b, l, r := base.Nodes[g], local.Nodes[g], remote.Nodes[g]
		switch {
		case l != nil && r != nil:
			if l.Kind != r.Kind {
				conflicts++
				decisions[g] = &decision{node: fields(r), parent: pR.get(g), side: sideRemote}
				continue
			}
			hasBase := b != nil && b.Kind == l.Kind
			var bTitle, bURL string
			if hasBase {
				bTitle, bURL = b.Title, b.URL
			}
			node := vault.Node{GUID: g, Kind: l.Kind, Title: pick(hasBase, bTitle, l.Title, r.Title)}
			if l.Kind == vault.Bookmark {
				node.URL = pick(hasBase, bURL, l.URL, r.URL)
			}
			lp, rp := pL.get(g), pR.get(g)
			bp := none
			if hasBase {
				bp = pB.get(g)
			}
			d := &decision{node: node}
			switch {
			case lp == rp:
				d.parent, d.side = rp, sideRemote
			case hasBase && lp == bp:
				d.parent, d.side = rp, sideRemote
			case hasBase && rp == bp:
				d.parent, d.side = lp, sideLocal
			default:
				conflicts++
				d.parent, d.side = rp, sideRemote
			}
			decisions[g] = d
		case l != nil:
			// Absent remotely: a local add, or a remote delete that a local edit overrides.
			if b == nil || edited(l, pL.get(g), b, pB.get(g)) {
				decisions[g] = &decision{node: fields(l), parent: pL.get(g), side: sideLocal}
			}
		case r != nil:
			if b == nil || edited(r, pR.get(g), b, pB.get(g)) {
				decisions[g] = &decision{node: fields(r), parent: pR.get(g), side: sideRemote}
			}
		}
		// Absent on both sides: deleted (or never synced) — drop.
	}

	isFolder := func(o opt) bool {
		if !o.ok {
			return false
		}
		if vault.IsRoot(o.g) {
			return true
		}
		d := decisions[o.g]
		return d != nil && d.node.Kind == vault.Folder
	}

	// 2. Re-home nodes whose parent did not survive.
	for _, d := range decisions {
		if isFolder(d.parent) {
			continue
		}
		chains := []parents{pR, pL, pB}
		if d.side == sideLocal {
			chains = []parents{pL, pR, pB}
		}
		d.parent = some(nearestSurvivor(d.parent, chains, isFolder))
	}

	// 3. Break cycles created by crossing moves.
	repairCycles(decisions, pR, isFolder)

	// 4. Order each folder's children.
	members := make(map[guid]map[guid]bool)
	for g, d := range decisions {
		set := members[d.parent.g]
		if set == nil {
			set = make(map[guid]bool)
			members[d.parent.g] = set
		}
		set[g] = true
	}

	nodes := make(map[guid]*vault.Node, len(decisions)+len(vault.Roots))
	for _, root := range vault.Roots {
		nodes[root] = &vault.Node{GUID: root, Kind: vault.Folder, Title: vault.RootTitle(root), Children: []guid{}}
	}
	for g, d := range decisions {
		n := d.node
		if n.Kind == vault.Folder {
			n.Children = []guid{}
		}
		nodes[g] = &n
	}
	for folder, set := range members {
		nodes[folder].Children = orderChildren(set, childrenOf(base, folder).list, childrenOf(local, folder), childrenOf(remote, folder))
	}

	doc := &vault.Doc{Format: vault.Format, Seq: remote.Seq, WrittenBy: remote.WrittenBy, WrittenAt: remote.WrittenAt, Nodes: nodes}
	return doc, Stats{ToLocal: vault.DiffStats(local, doc), ToRemote: vault.DiffStats(remote, doc), Conflicts: conflicts}
}

// edited reports a change of title, url or parent. A kind change always
// counts: in TS a folder's url is undefined and never equals a bookmark's.
func edited(n *vault.Node, parent opt, b *vault.Node, bParent opt) bool {
	return n.Title != b.Title || n.Kind != b.Kind || n.URL != b.URL || parent != bParent
}

// fields is the node's own fields, without children (rebuilt from parents).
func fields(n *vault.Node) vault.Node {
	if n.Kind == vault.Bookmark {
		return vault.Node{GUID: n.GUID, Kind: vault.Bookmark, Title: n.Title, URL: n.URL}
	}
	return vault.Node{GUID: n.GUID, Kind: vault.Folder, Title: n.Title}
}

// children is a folder's child list, or absent (`?.children` is undefined
// for a missing node or a bookmark).
type children struct {
	list []guid
	ok   bool
}

func childrenOf(d *vault.Doc, g guid) children {
	if n := d.Nodes[g]; n != nil && n.Kind == vault.Folder {
		return children{n.Children, true}
	}
	return children{}
}

// nearestSurvivor walks up from start (a deleted folder) to the first
// ancestor that survives, else Other Bookmarks.
func nearestSurvivor(start opt, chains []parents, survives func(opt) bool) guid {
	seen := make(map[guid]bool)
	g := start
	for g.ok && !survives(g) && !seen[g.g] {
		seen[g.g] = true
		from := g.g
		g = none
		for _, c := range chains {
			if p := c.get(from); p.ok {
				g = p
				break
			}
		}
	}
	if survives(g) {
		return g.g
	}
	return vault.RootOther
}

// repairCycles re-parents nodes whose parent chain loops: first to their
// remote parent, and if that still loops (or was already tried), to Other
// Bookmarks. Nodes are processed in GUID order for determinism.
func repairCycles(decisions map[guid]*decision, pR parents, isFolder func(opt) bool) {
	tried := make(map[guid]bool)
	for {
		cycle := findCycle(decisions)
		if cycle == nil {
			return
		}
		g := slices.MinFunc(cycle, vault.CompareGUID)
		d := decisions[g]
		rp := pR.get(g)
		if !tried[g] && rp.ok && rp != d.parent && isFolder(rp) {
			tried[g] = true
			d.parent = rp
		} else {
			d.parent = some(vault.RootOther)
		}
	}
}

func findCycle(decisions map[guid]*decision) []guid {
	done := make(map[guid]bool) // known to reach a root
	for _, start := range vault.SortedGUIDs(decisions) {
		var path []guid
		onPath := make(map[guid]bool)
		g := some(start)
		for g.ok && !vault.IsRoot(g.g) && !done[g.g] {
			if onPath[g.g] {
				return path[slices.Index(path, g.g):]
			}
			onPath[g.g] = true
			path = append(path, g.g)
			if d := decisions[g.g]; d != nil {
				g = d.parent
			} else {
				g = none
			}
		}
		for _, p := range path {
			done[p] = true
		}
	}
	return nil
}

// reordered reports whether side's order of the children it shares with
// base differs from base's.
func reordered(side, base []guid) bool {
	inSide := toSet(side)
	inBase := toSet(base)
	var a, b []guid
	for _, g := range side {
		if inBase[g] {
			a = append(a, g)
		}
	}
	for _, g := range base {
		if inSide[g] {
			b = append(b, g)
		}
	}
	for i, g := range a {
		if i >= len(b) || g != b[i] {
			return true
		}
	}
	return false
}

func toSet(gs []guid) map[guid]bool {
	m := make(map[guid]bool, len(gs))
	for _, g := range gs {
		m[g] = true
	}
	return m
}

// orderChildren orders a folder's final members. The authoritative order is
// local's if only local reordered, otherwise remote's. Members missing from
// it are inserted next to their neighbours in the order they came from;
// anything left (re-homed orphans) is appended in GUID order.
func orderChildren(members map[guid]bool, base []guid, local, remote children) []guid {
	var auth []guid
	var other children
	switch {
	case !remote.ok:
		auth = local.list // nil when local is absent too
	case !local.ok:
		auth = remote.list
	case reordered(local.list, base) && !reordered(remote.list, base):
		auth, other = local.list, remote
	default:
		auth, other = remote.list, local
	}

	result := []guid{}
	placed := make(map[guid]bool)
	for _, g := range auth {
		if members[g] && !placed[g] {
			result = append(result, g)
			placed[g] = true
		}
	}
	for _, order := range []children{other, {base, true}} {
		if !order.ok {
			continue
		}
		for i, g := range order.list {
			if !members[g] || placed[g] {
				continue
			}
			result = slices.Insert(result, insertionIndex(result, order.list, i), g)
			placed[g] = true
		}
	}
	for _, g := range vault.SortedGUIDs(members) {
		if !placed[g] {
			result = append(result, g)
		}
	}
	return result
}

// insertionIndex is the position after the nearest earlier neighbour in
// order already placed, else before the nearest later one, else the end.
func insertionIndex(result, order []guid, i int) int {
	for j := i - 1; j >= 0; j-- {
		if k := slices.Index(result, order[j]); k >= 0 {
			return k + 1
		}
	}
	for j := i + 1; j < len(order); j++ {
		if k := slices.Index(result, order[j]); k >= 0 {
			return k
		}
	}
	return len(result)
}
