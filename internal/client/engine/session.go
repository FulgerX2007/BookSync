package engine

import (
	"context"
	"fmt"
	"strings"

	"github.com/FulgerX2007/BookSync/internal/client/api"
	"github.com/FulgerX2007/BookSync/internal/client/crypto"
	"github.com/FulgerX2007/BookSync/internal/client/store"
)

// Kit is the emergency kit: what a person needs, besides the password, to
// sign in on another device. It never contains the password.
type Kit struct {
	Text     string `json:"text"`
	SyncID   string `json:"syncId"`
	FileName string `json:"fileName"`
}

func (e *Engine) kit(serverURL, username string, syncID []byte) Kit {
	id, _ := crypto.FormatSyncID(syncID)
	text := strings.Join([]string{
		"BookSync Emergency Kit",
		"======================",
		"",
		"Keep this somewhere safe: print it, or store it in your password manager.",
		"You need it, together with your password, to sign in on another device.",
		"",
		"Server:    " + serverURL,
		"Username:  " + username,
		"SyncID:    " + id,
		"Created:   " + e.opts.Now().UTC().Format("2006-01-02"),
		"",
		"Your password is not in this kit. Your bookmarks are encrypted with keys",
		"derived from the password AND the SyncID. Nobody can reset them, not even the",
		"server operator: if you lose either one, the synced copy cannot be recovered.",
		"",
	}, "\n")
	return Kit{Text: text, SyncID: id, FileName: "booksync-emergency-kit-" + username + ".txt"}
}

func validUsername(raw string) (string, error) {
	u := crypto.NormalizeUsername(raw)
	if !crypto.ValidUsername(u) {
		return "", fail(CodeInvalidUsername, `username must be 3-64 characters of a-z, 0-9, ".", "_" or "-"`)
	}
	return u, nil
}

func validPassword(pw string) error {
	if len([]rune(pw)) < MinPasswordLength {
		return fail(CodeWeakPassword, fmt.Sprintf("password must have at least %d characters", MinPasswordLength))
	}
	return nil
}

// Register creates an account with this device as its first device and
// returns the emergency kit. The password must be NFC-normalized.
func (e *Engine) Register(ctx context.Context, serverURL, username, nfcPassword string) (Kit, error) {
	base, err := api.NormalizeServerURL(serverURL)
	if err != nil {
		return Kit{}, err
	}
	u, err := validUsername(username)
	if err != nil {
		return Kit{}, err
	}
	if err := validPassword(nfcPassword); err != nil {
		return Kit{}, err
	}
	if err := e.requireSignedOut(); err != nil {
		return Kit{}, err
	}
	syncID := crypto.NewSyncID()
	keys, err := crypto.DeriveKeys(u, nfcPassword, syncID, crypto.MinIterations)
	if err != nil {
		return Kit{}, err
	}
	vaultKey := crypto.NewVaultKey()
	wrapped, err := crypto.WrapVaultKey(vaultKey, keys.KEK, u)
	if err != nil {
		return Kit{}, err
	}
	c, err := e.client(base, "")
	if err != nil {
		return Kit{}, err
	}
	s, err := c.Register(ctx, api.RegisterRequest{
		Username: u, AuthKey: keys.AuthKey, WrappedVaultKey: wrapped, DeviceName: e.opts.DeviceName,
		KDF: api.KDFParams{KDF: crypto.KDFName, Iterations: crypto.MinIterations},
	})
	if err != nil {
		return Kit{}, err
	}
	err = e.update(func(st *store.State) {
		*st = *store.NewState()
		st.LocalRev++ // nothing from before may commit
		st.Session = &store.Session{
			ServerURL: base, Username: u, UserID: s.UserID, DeviceID: s.DeviceID, DeviceToken: s.DeviceToken,
			SyncID: syncID, Iterations: crypto.MinIterations, WrappedVaultKey: wrapped, VaultKey: vaultKey,
		}
	})
	if err != nil {
		return Kit{}, err
	}
	return e.kit(base, u, syncID), nil
}

// Login signs this device in. On a signed-out device it joins the account;
// after a 401 it re-authenticates the same account and keeps base, so the
// next sync is a guarded three-way merge. The password must be NFC-normalized.
func (e *Engine) Login(ctx context.Context, serverURL, username, nfcPassword, syncIDText string) error {
	base, err := api.NormalizeServerURL(serverURL)
	if err != nil {
		return err
	}
	u, err := validUsername(username)
	if err != nil {
		return err
	}
	syncID, err := crypto.ParseSyncID(syncIDText)
	if err != nil {
		return err
	}
	prev := e.currentSession()
	if prev != nil {
		if prev.DeviceToken != "" {
			return fail(CodeAlreadySignedIn, "this device is already signed in")
		}
		if prev.ServerURL != base || prev.Username != u {
			return fail(CodeDifferentUser, "sign out first: this device holds another account's bookmarks")
		}
	}
	c, err := e.client(base, "")
	if err != nil {
		return err
	}
	params, err := c.Prelogin(ctx, u)
	if err != nil {
		return err
	}
	keys, err := crypto.DeriveKeys(u, nfcPassword, syncID, params.Iterations)
	if err != nil {
		return err
	}
	s, err := c.Login(ctx, u, keys.AuthKey, e.opts.DeviceName)
	if err != nil {
		return err
	}
	vaultKey, err := crypto.UnwrapVaultKey(s.WrappedVaultKey, keys.KEK, u)
	if err != nil {
		e.revoke(ctx, base, s.DeviceToken)
		return fail(api.CodeInvalidCredentials, "username, password or SyncID is incorrect")
	}
	if prev != nil && prev.UserID != s.UserID {
		// Same name, but the account was deleted and re-created meanwhile.
		e.revoke(ctx, base, s.DeviceToken)
		return fail(CodeDifferentUser, "sign out first: this device holds another account's bookmarks")
	}
	return e.update(func(st *store.State) {
		if prev == nil {
			*st = *store.NewState()
			st.LocalRev++
		}
		st.Session = &store.Session{
			ServerURL: base, Username: u, UserID: s.UserID, DeviceID: s.DeviceID, DeviceToken: s.DeviceToken,
			SyncID: syncID, Iterations: s.Iterations, WrappedVaultKey: s.WrappedVaultKey, VaultKey: vaultKey,
		}
		st.Sync.LastError = ""
		if st.Sync.Status == StatusSignedOut {
			st.Sync.Status = ""
		}
	})
}

// Logout revokes this device on the server when possible and forgets the
// account, the sync state and the local bookmarks on this device.
func (e *Engine) Logout(ctx context.Context) error {
	if ss := e.currentSession(); ss != nil && ss.DeviceToken != "" {
		e.revoke(ctx, ss.ServerURL, ss.DeviceToken)
	}
	return e.update(func(st *store.State) { st.ClearSession() })
}

// DeleteAccount permanently deletes the account on the server (every device
// and every vault version) and then forgets it here, like Logout. The user
// confirms by typing the username and the password; both are checked before
// anything is deleted. The password must be NFC-normalized.
func (e *Engine) DeleteAccount(ctx context.Context, confirmUsername, nfcPassword string) error {
	ss := e.currentSession()
	if ss == nil || ss.DeviceToken == "" {
		return fail(CodeNotSignedIn, "sign in to delete the account")
	}
	if crypto.NormalizeUsername(confirmUsername) != ss.Username {
		return fail(CodeUsernameMismatch, "type your username exactly to confirm")
	}
	keys, err := crypto.DeriveKeys(ss.Username, nfcPassword, ss.SyncID, ss.Iterations)
	if err != nil {
		return err
	}
	c, err := e.client(ss.ServerURL, ss.DeviceToken)
	if err != nil {
		return err
	}
	if err := c.DeleteAccount(ctx, keys.AuthKey); err != nil {
		return e.checkAuth(err, ss.DeviceToken)
	}
	return e.update(func(st *store.State) { st.ClearSession() })
}

// revoke signs a token out server-side, best effort.
func (e *Engine) revoke(ctx context.Context, serverURL, token string) {
	if c, err := e.client(serverURL, token); err == nil {
		_ = c.Logout(ctx)
	}
}

func (e *Engine) currentSession() *store.Session {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.state.Session == nil {
		return nil
	}
	s := *e.state.Session
	return &s
}

func (e *Engine) requireSignedOut() error {
	if e.currentSession() != nil {
		return fail(CodeAlreadySignedIn, "sign out first")
	}
	return nil
}
