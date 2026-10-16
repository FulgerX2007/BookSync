package vault

// ViolationKind names a structural problem (ViolationKind in the extension).
type ViolationKind string

// Violation kinds.
const (
	MissingRoot     ViolationKind = "missing_root"
	GUIDMismatch    ViolationKind = "guid_mismatch"
	BadBookmark     ViolationKind = "bad_bookmark"
	BadFolder       ViolationKind = "bad_folder"
	DanglingChild   ViolationKind = "dangling_child"
	MultipleParents ViolationKind = "multiple_parents"
	RootHasParent   ViolationKind = "root_has_parent"
	Cycle           ViolationKind = "cycle"
	Unreachable     ViolationKind = "unreachable"
)

// Violation is one structural problem at one node.
type Violation struct {
	Kind ViolationKind
	GUID GUID
}

// Validate lists every structural problem (protocol §2); an empty result
// means the tree is valid. Nodes are visited in CompareGUID order.
func Validate(d *Doc) []Violation {
	var out []Violation
	nodes := d.Nodes
	for _, r := range Roots {
		if n := nodes[r]; n == nil || n.Kind != Folder {
			out = append(out, Violation{MissingRoot, r})
		}
	}

	keys := SortedGUIDs(nodes)
	parentCount := make(map[GUID]int)
	var counted []GUID
	for _, key := range keys {
		n := nodes[key]
		if n.GUID != key {
			out = append(out, Violation{GUIDMismatch, key})
		}
		switch n.Kind {
		case Bookmark:
			if n.Children != nil {
				out = append(out, Violation{BadBookmark, key})
			}
		case Folder:
			if n.URL != "" {
				out = append(out, Violation{BadFolder, key})
			}
		default:
			out = append(out, Violation{BadFolder, key})
		}
		for _, c := range n.Children {
			if nodes[c] == nil {
				out = append(out, Violation{DanglingChild, c})
			}
			if IsRoot(c) {
				out = append(out, Violation{RootHasParent, c})
			}
			if parentCount[c] == 0 {
				counted = append(counted, c)
			}
			parentCount[c]++
		}
	}
	for _, c := range counted {
		if parentCount[c] > 1 {
			out = append(out, Violation{MultipleParents, c})
		}
	}

	// Everything must hang off a root; nodes that don't are orphaned or in a cycle.
	reachable := make(map[GUID]bool, len(nodes))
	var stack []GUID
	for _, r := range Roots {
		if nodes[r] != nil {
			stack = append(stack, r)
		}
	}
	for len(stack) > 0 {
		g := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if reachable[g] {
			continue
		}
		reachable[g] = true
		for _, c := range nodes[g].Children {
			if nodes[c] != nil {
				stack = append(stack, c)
			}
		}
	}
	parents := d.Parents()
	for _, g := range keys {
		if reachable[g] {
			continue
		}
		kind := Unreachable
		if inCycle(g, parents) {
			kind = Cycle
		}
		out = append(out, Violation{kind, g})
	}
	return out
}

// inCycle reports whether start's ancestor chain loops.
func inCycle(start GUID, parents map[GUID]GUID) bool {
	seen := make(map[GUID]bool)
	for g, ok := start, true; ok; g, ok = parents[g] {
		if seen[g] {
			return true
		}
		seen[g] = true
	}
	return false
}
