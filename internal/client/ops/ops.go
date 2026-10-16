// Package ops edits the local bookmark tree, mirroring the rules of
// extension/src/bookmarks/ops.ts: roots are locked, positions are anchors
// ("after sibling P", first, or last), and every result is a valid tree.
// The Android app is its own bookmark store, so these edits are what the
// browser's bookmark API is to the extension.
package ops

import (
	"errors"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

// Error codes. Callers branch on them.
const (
	CodeRootLocked  = "root_locked"  // roots are never renamed, moved or deleted
	CodeStale       = "stale"        // a node or anchor is gone; re-read and retry
	CodeNotFolder   = "not_folder"   // only folders can hold children
	CodeNotBookmark = "not_bookmark" // folders have no URL
	CodeInvalidURL  = "invalid_url"
	CodeInvalidMove = "invalid_move" // into itself or its own subtree
)

// Error is a refused edit.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return "ops: " + e.Message }

// CodeOf returns the code of an ops *Error in err's chain, or "".
func CodeOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

func fail(code, msg string) error { return &Error{Code: code, Message: msg} }

// Position is where a new or moved node goes: after a sibling, first (the
// zero value), or last.
type Position struct {
	After vault.GUID
	End   bool
}

// First and End are the positions without an anchor.
var (
	First = Position{}
	End   = Position{End: true}
)

// After positions a node right after sibling g.
func After(g vault.GUID) Position { return Position{After: g} }

var schemeRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)

// special are the WHATWG special schemes, which require a host (file aside).
var special = map[string]bool{"http": true, "https": true, "ws": true, "wss": true, "ftp": true}

// ParseURL validates a URL a person typed and returns it trimmed. Like the
// extension (new URL(url)), it requires an absolute URL; special schemes
// need a host. Go's parser is laxer than WHATWG's, so this is a close
// approximation; it only gates input and never changes what is synced.
func ParseURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	invalid := fail(CodeInvalidURL, "Enter a full URL, like https://example.com/.")
	if !schemeRE.MatchString(s) {
		return "", invalid
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", invalid
	}
	if special[strings.ToLower(u.Scheme)] && (u.Host == "" || strings.ContainsAny(u.Host, " <>^|%\\")) {
		return "", invalid
	}
	return s, nil
}

func folder(d *vault.Doc, g vault.GUID) (*vault.Node, error) {
	n := d.Nodes[g]
	if n == nil {
		return nil, fail(CodeStale, "that folder no longer exists")
	}
	if n.Kind != vault.Folder {
		return nil, fail(CodeNotFolder, "only folders can hold bookmarks")
	}
	return n, nil
}

func nonRoot(d *vault.Doc, g vault.GUID) (*vault.Node, error) {
	if vault.IsRoot(g) {
		return nil, fail(CodeRootLocked, "root folders cannot be renamed, moved or deleted")
	}
	n := d.Nodes[g]
	if n == nil {
		return nil, fail(CodeStale, "that bookmark no longer exists")
	}
	return n, nil
}

// insertAt places g in parent's children at pos.
func insertAt(parent *vault.Node, g vault.GUID, pos Position) error {
	kids := parent.Children
	switch {
	case pos.End:
		parent.Children = append(kids, g)
	case pos.After == "":
		parent.Children = slices.Insert(kids, 0, g)
	default:
		i := slices.Index(kids, pos.After)
		if i < 0 {
			return fail(CodeStale, "the position changed meanwhile")
		}
		parent.Children = slices.Insert(kids, i+1, g)
	}
	return nil
}

func newGUID(d *vault.Doc) vault.GUID {
	for {
		if g := vault.NewGUID(); d.Nodes[g] == nil {
			return g
		}
	}
}

// AddBookmark creates a bookmark in parent at pos and returns its GUID.
func AddBookmark(d *vault.Doc, parent vault.GUID, pos Position, title, rawURL string) (vault.GUID, error) {
	u, err := ParseURL(rawURL)
	if err != nil {
		return "", err
	}
	return add(d, parent, pos, &vault.Node{Kind: vault.Bookmark, Title: title, URL: u})
}

// AddFolder creates an empty folder in parent at pos and returns its GUID.
func AddFolder(d *vault.Doc, parent vault.GUID, pos Position, title string) (vault.GUID, error) {
	return add(d, parent, pos, &vault.Node{Kind: vault.Folder, Title: title, Children: []vault.GUID{}})
}

func add(d *vault.Doc, parent vault.GUID, pos Position, n *vault.Node) (vault.GUID, error) {
	p, err := folder(d, parent)
	if err != nil {
		return "", err
	}
	n.GUID = newGUID(d)
	if err := insertAt(p, n.GUID, pos); err != nil {
		return "", err
	}
	d.Nodes[n.GUID] = n
	return n.GUID, nil
}

// Rename sets a node's title.
func Rename(d *vault.Doc, g vault.GUID, title string) error {
	n, err := nonRoot(d, g)
	if err != nil {
		return err
	}
	n.Title = title
	return nil
}

// SetURL sets a bookmark's URL.
func SetURL(d *vault.Doc, g vault.GUID, rawURL string) error {
	n, err := nonRoot(d, g)
	if err != nil {
		return err
	}
	if n.Kind != vault.Bookmark {
		return fail(CodeNotBookmark, "folders have no URL")
	}
	u, err := ParseURL(rawURL)
	if err != nil {
		return err
	}
	n.URL = u
	return nil
}

// Move puts g into parent at pos. Moving a folder into itself or its own
// subtree is refused; moving a node after itself changes nothing.
func Move(d *vault.Doc, g, parent vault.GUID, pos Position) error {
	if _, err := nonRoot(d, g); err != nil {
		return err
	}
	p, err := folder(d, parent)
	if err != nil {
		return err
	}
	if pos.After == g && !pos.End {
		return nil
	}
	parents := d.Parents()
	for a, ok := parent, true; ok; a, ok = parents[a] {
		if a == g {
			return fail(CodeInvalidMove, "a folder cannot be moved into itself")
		}
	}
	if !pos.End && pos.After != "" && !slices.Contains(p.Children, pos.After) {
		return fail(CodeStale, "the position changed meanwhile")
	}
	old := d.Nodes[parents[g]]
	old.Children = slices.DeleteFunc(old.Children, func(c vault.GUID) bool { return c == g })
	return insertAt(p, g, pos)
}

// Delete removes a node and, for a folder, everything in it.
func Delete(d *vault.Doc, g vault.GUID) error {
	if _, err := nonRoot(d, g); err != nil {
		return err
	}
	if parent, ok := d.Parents()[g]; ok {
		p := d.Nodes[parent]
		p.Children = slices.DeleteFunc(p.Children, func(c vault.GUID) bool { return c == g })
	}
	removeSubtree(d, g)
	return nil
}

func removeSubtree(d *vault.Doc, g vault.GUID) {
	if n := d.Nodes[g]; n != nil {
		for _, c := range n.Children {
			removeSubtree(d, c)
		}
	}
	delete(d.Nodes, g)
}

// CountSubtree counts the bookmarks and folders below g (g excluded), for
// delete confirmations.
func CountSubtree(d *vault.Doc, g vault.GUID) (bookmarks, folders int) {
	n := d.Nodes[g]
	if n == nil {
		return 0, 0
	}
	for _, c := range n.Children {
		if cn := d.Nodes[c]; cn != nil {
			if cn.Kind == vault.Folder {
				folders++
			} else {
				bookmarks++
			}
			b, f := CountSubtree(d, c)
			bookmarks, folders = bookmarks+b, folders+f
		}
	}
	return bookmarks, folders
}
