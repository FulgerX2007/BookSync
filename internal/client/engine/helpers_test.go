package engine

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/FulgerX2007/BookSync/internal/client/ops"
	"github.com/FulgerX2007/BookSync/internal/client/testserver"
	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

var ctx = context.Background()

const password = "correct horse battery"

// keystore stands in for the Android Keystore.
type keystore struct{}

func (keystore) gcm() cipher.AEAD {
	b, _ := aes.NewCipher(bytes.Repeat([]byte{7}, 32))
	g, _ := cipher.NewGCM(b)
	return g
}

func (k keystore) Wrap(key []byte) ([]byte, error) {
	iv := make([]byte, 12)
	return k.gcm().Seal(iv, iv, key, nil), nil
}

func (k keystore) Unwrap(b []byte) ([]byte, error) {
	if len(b) < 12 {
		return nil, errors.New("short")
	}
	return k.gcm().Open(nil, b[:12], b[12:], nil)
}

// device is one app installation, with a request counter on its transport.
type device struct {
	*Engine
	net *testserver.Counter
	dir string
}

func newDevice(t *testing.T, name string) *device {
	t.Helper()
	return openDevice(t, t.TempDir(), name)
}

func openDevice(t *testing.T, dir, name string) *device {
	t.Helper()
	counter := &testserver.Counter{}
	e, err := Open(Options{
		Dir: dir, KeyWrapper: keystore{}, DeviceName: name,
		HTTPClient: &http.Client{Transport: counter, Timeout: 30 * time.Second},
		Now:        func() time.Time { return time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	return &device{Engine: e, net: counter, dir: dir}
}

func mustRegister(t *testing.T, d *device, url, user string) Kit {
	t.Helper()
	kit, err := d.Register(ctx, url, user, password)
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	return kit
}

func mustLogin(t *testing.T, d *device, url, user, syncID string) {
	t.Helper()
	if err := d.Login(ctx, url, user, password, syncID); err != nil {
		t.Fatalf("Login: %v", err)
	}
}

// addBookmark adds a bookmark at the end of the toolbar.
func addBookmark(t *testing.T, d *device, title string) vault.GUID {
	t.Helper()
	var g vault.GUID
	err := d.Edit(func(doc *vault.Doc) (err error) {
		g, err = ops.AddBookmark(doc, vault.RootToolbar, ops.End, title, "https://"+title+".example/")
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return g
}

// revokeDevice revokes deviceID using another device's token, as the device
// list of a browser extension does.
func revokeDevice(t *testing.T, srv *testserver.Server, byToken, deviceID string) {
	t.Helper()
	req, _ := http.NewRequestWithContext(ctx, http.MethodDelete, srv.URL+"/v1/devices/"+deviceID, nil)
	req.Header.Set("Authorization", "Bearer "+byToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke: %d", resp.StatusCode)
	}
}

func session(d *device) (token, deviceID string) {
	s := d.currentSession()
	return s.DeviceToken, s.DeviceID
}
