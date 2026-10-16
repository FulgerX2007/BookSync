// Package mobile is the gomobile facade over internal/client for the
// Android app. Its API uses only bindable types: strings (JSON for trees,
// status and results), []byte, int64, bool, error, and the KeyWrapper
// interface that Kotlin implements with the Android Keystore.
//
// Every error crosses the boundary as a JSON string {"code","message"}, so
// Kotlin branches on the code like the extension does.
package mobile

import (
	"context"
	"encoding/json"

	"github.com/FulgerX2007/BookSync/internal/client/crypto"
	"github.com/FulgerX2007/BookSync/internal/client/engine"
	"github.com/FulgerX2007/BookSync/internal/client/ops"
	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

// Version identifies the core build; Kotlin shows it in About.
const Version = "1"

// CoreVersion returns Version (constants are not bound by gomobile).
func CoreVersion() string { return Version }

// KeyWrapper protects the 32-byte data key that seals the local state.
// Kotlin implements it with a non-exportable Android Keystore AES-GCM key.
type KeyWrapper interface {
	Wrap(dataKey []byte) ([]byte, error)
	Unwrap(wrapped []byte) ([]byte, error)
}

// CoreError is the error type Kotlin sees; Error() is its JSON.
type CoreError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *CoreError) Error() string {
	b, _ := json.Marshal(e)
	return string(b)
}

func wrap(err error) error {
	if err == nil {
		return nil
	}
	return &CoreError{Code: engine.CodeOf(err), Message: err.Error()}
}

// Core is one app installation. Create a single instance per process.
type Core struct {
	e *engine.Engine
}

// NewCore opens (or creates) the sealed state in dir.
func NewCore(dir string, wrapper KeyWrapper, deviceName string) (*Core, error) {
	if wrapper == nil {
		return nil, &CoreError{Code: "invalid_request", Message: "a KeyWrapper is required"}
	}
	e, err := engine.Open(engine.Options{Dir: dir, KeyWrapper: wrapper, DeviceName: deviceName})
	if err != nil {
		return nil, wrap(err)
	}
	return &Core{e: e}, nil
}

var bg = context.Background()

// Register creates an account and returns the emergency kit as JSON
// {"text","syncId","fileName"}. nfcPassword must be NFC-normalized.
func (c *Core) Register(serverURL, username, nfcPassword string) (string, error) {
	kit, err := c.e.Register(bg, serverURL, username, nfcPassword)
	if err != nil {
		return "", wrap(err)
	}
	return marshal(kit), nil
}

// Login signs this device in. nfcPassword must be NFC-normalized.
func (c *Core) Login(serverURL, username, nfcPassword, syncID string) error {
	return wrap(c.e.Login(bg, serverURL, username, nfcPassword, syncID))
}

// Logout signs out and forgets this device's bookmarks.
func (c *Core) Logout() error { return wrap(c.e.Logout(bg)) }

// Status returns the status as JSON (engine.Status).
func (c *Core) Status() string { return marshal(c.e.Status()) }

// Tree returns the local bookmark tree as vault JSON.
func (c *Core) Tree() (string, error) {
	b, err := vault.Marshal(c.e.Tree())
	if err != nil {
		return "", wrap(err)
	}
	return string(b), nil
}

func position(after string, atEnd bool) ops.Position {
	if atEnd {
		return ops.End
	}
	return ops.After(after) // "" is first
}

// AddBookmark adds a bookmark to parent after the sibling `after` ("" for
// first, or atEnd) and returns its GUID.
func (c *Core) AddBookmark(parent, after string, atEnd bool, title, url string) (string, error) {
	var g vault.GUID
	err := c.e.Edit(func(d *vault.Doc) (err error) {
		g, err = ops.AddBookmark(d, parent, position(after, atEnd), title, url)
		return err
	})
	return g, wrap(err)
}

// AddFolder adds an empty folder and returns its GUID.
func (c *Core) AddFolder(parent, after string, atEnd bool, title string) (string, error) {
	var g vault.GUID
	err := c.e.Edit(func(d *vault.Doc) (err error) {
		g, err = ops.AddFolder(d, parent, position(after, atEnd), title)
		return err
	})
	return g, wrap(err)
}

// Rename sets a node's title.
func (c *Core) Rename(guid, title string) error {
	return wrap(c.e.Edit(func(d *vault.Doc) error { return ops.Rename(d, guid, title) }))
}

// SetURL sets a bookmark's URL.
func (c *Core) SetURL(guid, url string) error {
	return wrap(c.e.Edit(func(d *vault.Doc) error { return ops.SetURL(d, guid, url) }))
}

// Move puts guid into parent after the sibling `after` ("" for first, or atEnd).
func (c *Core) Move(guid, parent, after string, atEnd bool) error {
	return wrap(c.e.Edit(func(d *vault.Doc) error { return ops.Move(d, guid, parent, position(after, atEnd)) }))
}

// Delete removes a node and everything in it.
func (c *Core) Delete(guid string) error {
	return wrap(c.e.Edit(func(d *vault.Doc) error { return ops.Delete(d, guid) }))
}

// CountSubtree returns {"bookmarks","folders"} below guid, for delete prompts.
func (c *Core) CountSubtree(guid string) string {
	b, f := ops.CountSubtree(c.e.Tree(), guid)
	return marshal(map[string]int{"bookmarks": b, "folders": f})
}

// Sync runs once and returns the result as JSON (engine.Result). It never
// fails: errors are reported in the result.
func (c *Core) Sync() string { return marshal(c.e.Sync(bg, engine.SyncOptions{})) }

// ConfirmDeletions re-runs a sync the user confirmed after needs_confirmation.
func (c *Core) ConfirmDeletions() string { return marshal(c.e.ConfirmDeletions(bg)) }

// ResolveRollback answers rollback_detected with "use_local" or "accept_remote".
func (c *Core) ResolveRollback(choice string) string {
	return marshal(c.e.ResolveRollback(bg, engine.Recovery(choice)))
}

// ParseSyncID validates a typed SyncID and returns its canonical form.
func ParseSyncID(s string) (string, error) {
	id, err := crypto.ParseSyncID(s)
	if err != nil {
		return "", wrap(err)
	}
	return crypto.FormatSyncID(id)
}

func marshal(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return `{"status":"error","code":"internal","message":"encoding failed"}`
	}
	return string(b)
}
