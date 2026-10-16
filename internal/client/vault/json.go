package vault

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"unicode/utf8"
)

// Error codes (VaultDocErrorCode in the extension).
const (
	CodeUnsupportedFormat = "unsupported_format"
	CodeBadFormat         = "bad_format"
)

// Error is a document that cannot be used, with a stable code.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return "vault: " + e.Message }

func badFormat(format string, args ...any) *Error {
	return &Error{Code: CodeBadFormat, Message: fmt.Sprintf(format, args...)}
}

// CodeOf returns the code of a vault *Error in err's chain, or "".
func CodeOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// MarshalJSON emits exactly the fields the extension requires: a bookmark
// always carries "url" (even "") and never "children"; a folder always
// carries "children" ([] when empty, never null) and never "url".
func (n *Node) MarshalJSON() ([]byte, error) {
	if n.Kind == Bookmark {
		return encode(struct {
			GUID  GUID   `json:"guid"`
			Kind  Kind   `json:"kind"`
			Title string `json:"title"`
			URL   string `json:"url"`
		}{n.GUID, n.Kind, n.Title, n.URL})
	}
	children := n.Children
	if children == nil {
		children = []GUID{}
	}
	return encode(struct {
		GUID     GUID   `json:"guid"`
		Kind     Kind   `json:"kind"`
		Title    string `json:"title"`
		Children []GUID `json:"children"`
	}{n.GUID, n.Kind, n.Title, children})
}

// UnmarshalJSON reads a node with the extension's rules (parseNode).
func (n *Node) UnmarshalJSON(b []byte) error {
	var v any
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		return badFormat("vault node is malformed")
	}
	node, err := parseNode(v)
	if err != nil {
		return err
	}
	*n = *node
	return nil
}

// Marshal encodes a document as UTF-8 JSON, the plaintext of an envelope.
func Marshal(d *Doc) ([]byte, error) { return encode(d) }

// encode is json.Marshal without HTML escaping (<, > and & stay as they are,
// as in JSON.stringify).
func encode(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// maxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER.
const maxSafeInteger = 1<<53 - 1

// Parse decodes and fully validates a decrypted document with exactly the
// extension's rules (parseVaultDoc): unknown fields are ignored, a bookmark's
// children and a folder's url are dropped, and any structural violation is
// bad_format. A format newer than ours is unsupported_format and must never
// be overwritten.
func Parse(b []byte) (*Doc, error) {
	if !utf8.Valid(b) {
		return nil, badFormat("vault is not valid JSON")
	}
	var raw any
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil || dec.More() {
		return nil, badFormat("vault is not valid JSON")
	}
	if _, err := dec.Token(); err == nil {
		return nil, badFormat("vault is not valid JSON")
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil, badFormat("vault has no format version")
	}
	format, ok := number(obj["format"])
	if !ok {
		return nil, badFormat("vault has no format version")
	}
	if format > Format {
		return nil, &Error{Code: CodeUnsupportedFormat, Message: fmt.Sprintf("vault format %v is newer than this client supports; update BookSync", format)}
	}
	seq, seqOK := number(obj["seq"])
	writtenBy, wbOK := obj["writtenBy"].(string)
	writtenAt, waOK := number(obj["writtenAt"])
	nodes, nodesOK := obj["nodes"].(map[string]any)
	if format != Format || !seqOK || seq != math.Trunc(seq) || math.Abs(seq) > maxSafeInteger || !wbOK || !waOK || !nodesOK {
		return nil, badFormat("vault header is malformed")
	}
	d := &Doc{Format: Format, Seq: int64(seq), WrittenBy: writtenBy, WrittenAt: writtenAt, Nodes: make(map[GUID]*Node, len(nodes))}
	for _, key := range SortedGUIDs(nodes) {
		n, err := parseNode(nodes[key])
		if err != nil {
			return nil, err
		}
		d.Nodes[key] = n
	}
	if vs := Validate(d); len(vs) > 0 {
		return nil, badFormat("vault tree is invalid: %s at %s", vs[0].Kind, vs[0].GUID)
	}
	return d, nil
}

func parseNode(v any) (*Node, error) {
	obj, ok := v.(map[string]any)
	guid, gOK := obj["guid"].(string)
	title, tOK := obj["title"].(string)
	if !ok || !gOK || !tOK {
		return nil, badFormat("vault node is malformed")
	}
	switch obj["kind"] {
	case string(Bookmark):
		if url, ok := obj["url"].(string); ok {
			return &Node{GUID: guid, Kind: Bookmark, Title: title, URL: url}, nil
		}
	case string(Folder):
		if list, ok := obj["children"].([]any); ok {
			children := make([]GUID, 0, len(list))
			for _, c := range list {
				s, ok := c.(string)
				if !ok {
					return nil, badFormat("vault node %s is malformed", guid)
				}
				children = append(children, s)
			}
			return &Node{GUID: guid, Kind: Folder, Title: title, Children: children}, nil
		}
	}
	return nil, badFormat("vault node %s is malformed", guid)
}

// number reads a JSON number like JSON.parse: out-of-range values become
// ±Inf instead of failing.
func number(v any) (float64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := strconv.ParseFloat(string(n), 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return 0, false
	}
	return f, true
}
