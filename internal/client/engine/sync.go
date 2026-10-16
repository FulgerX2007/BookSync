package engine

import (
	"context"
	"time"

	"github.com/FulgerX2007/BookSync/internal/client/api"
	"github.com/FulgerX2007/BookSync/internal/client/crypto"
	"github.com/FulgerX2007/BookSync/internal/client/merge"
	"github.com/FulgerX2007/BookSync/internal/client/store"
	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

// MaxAttempts bounds the restarts of one run (MAX_ATTEMPTS in the extension).
const MaxAttempts = 3

// Sync statuses (SyncResult in the extension, plus busy).
const (
	StatusOK                = "ok"
	StatusNeedsConfirmation = "needs_confirmation"
	StatusRollbackDetected  = "rollback_detected"
	StatusConflictExhausted = "conflict_exhausted"
	StatusSignedOut         = "signed_out"
	StatusBusy              = "busy"
	StatusError             = "error"
)

// Recovery is the user's way out of rollback_detected (protocol §4.3).
type Recovery string

// Recoveries.
const (
	UseLocal     Recovery = "use_local"
	AcceptRemote Recovery = "accept_remote"
)

// SyncOptions carry the user's answers to a previous run.
type SyncOptions struct {
	// Confirmation is the pending summary the user confirmed.
	Confirmation *merge.Pending
	// Recovery answers rollback_detected.
	Recovery Recovery
}

// Result is the outcome of one run.
type Result struct {
	Status   string `json:"status"`
	Uploaded bool   `json:"uploaded,omitempty"`
	Version  int64  `json:"version,omitempty"`
	// Changed reports that the run replaced the local tree.
	Changed bool           `json:"changed,omitempty"`
	Pending *merge.Pending `json:"pending,omitempty"`
	// RemoteSeq (nil: the vault was emptied) and LastSeq for rollback_detected.
	RemoteSeq *int64 `json:"remoteSeq,omitempty"`
	LastSeq   int64  `json:"lastSeq,omitempty"`
	// Code, Message and RetryAfterMs describe an error.
	Code         string `json:"code,omitempty"`
	Message      string `json:"message,omitempty"`
	RetryAfterMs int64  `json:"retryAfterMs,omitempty"`
}

// Sync runs once, unless a run is already in flight (status busy). It never
// returns an error: failures are reported in the Result.
func (e *Engine) Sync(ctx context.Context, opts SyncOptions) Result {
	if !e.runMu.TryLock() {
		return Result{Status: StatusBusy}
	}
	defer e.runMu.Unlock()
	res, err := e.run(ctx, opts)
	if err == nil {
		return res
	}
	if isUnauthorized(err) {
		return Result{Status: StatusSignedOut}
	}
	r := Result{Status: StatusError, Code: CodeOf(err), Message: err.Error()}
	if ae, ok := err.(*api.Error); ok && ae.RetryAfter > 0 { //nolint:errorlint // api errors are returned unwrapped
		r.RetryAfterMs = ae.RetryAfter.Milliseconds()
	}
	if r.Code != CodeNotSignedIn {
		_ = e.update(func(s *store.State) { s.Sync.Status, s.Sync.LastError = StatusError, r.Message })
	}
	return r
}

// ConfirmDeletions re-runs the sync the user confirmed (needs_confirmation).
// The confirmation covers only the same server version and at most the
// confirmed deletions; anything else asks again.
func (e *Engine) ConfirmDeletions(ctx context.Context) Result {
	e.mu.Lock()
	pending := e.state.Sync.PendingConfirmation
	e.mu.Unlock()
	if pending == nil {
		return e.Sync(ctx, SyncOptions{})
	}
	return e.Sync(ctx, SyncOptions{Confirmation: pending})
}

// ResolveRollback re-runs the sync with the user's choice after
// rollback_detected. It is never chosen automatically.
func (e *Engine) ResolveRollback(ctx context.Context, choice Recovery) Result {
	if choice != UseLocal && choice != AcceptRemote {
		return Result{Status: StatusError, Code: "invalid_request", Message: "unknown recovery " + string(choice)}
	}
	return e.Sync(ctx, SyncOptions{Recovery: choice})
}

// run is protocol §4.1 for a client whose local tree is its store:
// fetch, rollback check, merge, guard, upload, and then one atomic commit
// of {local = merged, base, version, lastSeq} that happens only if the user
// did not edit meanwhile. So base advances only once the local tree and the
// server both hold merged, and an edit made during the run is never lost:
// the run restarts and merges it.
func (e *Engine) run(ctx context.Context, opts SyncOptions) (Result, error) {
	for range MaxAttempts {
		snap, err := e.snapshot()
		if err != nil {
			return Result{}, err
		}
		ss, base := snap.session, snap.sync.Base
		c, err := e.client(ss.ServerURL, ss.DeviceToken)
		if err != nil {
			return Result{}, err
		}

		// Fetch.
		var ifNoneMatch int64
		if base != nil {
			ifNoneMatch = snap.sync.Version
		}
		got, err := c.GetVault(ctx, ifNoneMatch)
		if err != nil {
			return Result{}, e.checkAuth(err, ss.DeviceToken)
		}
		var remote *vault.Doc
		var remoteVersion *int64
		switch got.Status {
		case api.VaultNotModified:
			remote, remoteVersion = base, ptr(snap.sync.Version)
		case api.VaultEmpty:
		case api.VaultOK:
			plain, err := crypto.OpenVault(got.Body, ss.VaultKey, ss.Username)
			if err != nil {
				return Result{}, err
			}
			if remote, err = vault.Parse(plain); err != nil {
				return Result{}, err
			}
			remoteVersion = ptr(got.Version)
		}

		// Rollback check (protocol §4.3): never resolved automatically.
		lastSeq := snap.sync.LastSeq
		rolledBack := base != nil && (remote == nil || remote.Seq < lastSeq)
		if rolledBack && opts.Recovery == "" {
			rb := &store.Rollback{LastSeq: lastSeq}
			if remoteVersion != nil {
				rb.RemoteVersion = *remoteVersion
			}
			var remoteSeq *int64
			if remote != nil {
				remoteSeq, rb.RemoteSeq = ptr(remote.Seq), ptr(remote.Seq)
			}
			err := e.update(func(s *store.State) { s.Sync.Status, s.Sync.Rollback = StatusRollbackDetected, rb })
			return Result{Status: StatusRollbackDetected, RemoteSeq: remoteSeq, LastSeq: lastSeq}, err
		}
		if rolledBack && opts.Recovery == AcceptRemote {
			lastSeq = 0
			if remote != nil {
				lastSeq = remote.Seq
			}
		}

		// Merge.
		local := snap.local
		var merged *vault.Doc
		switch {
		case rolledBack && opts.Recovery == UseLocal:
			merged = local.Clone()
		case base == nil:
			// First sync: this device only gets here signed out or freshly
			// signed in, so its own tree is empty and the server's is adopted.
			if local.CountNodes() > 0 {
				return Result{}, fail(CodeLocalNotEmpty, "this device has bookmarks but no sync history; sign out and in again")
			}
			if remote != nil {
				merged = remote.Clone()
			} else {
				merged = vault.NewEmpty()
			}
		default:
			r := remote
			if r == nil {
				r = vault.NewEmpty()
			}
			merged, _ = merge.Merge3(base, local, r)
		}

		// Guard (protocol §4.6).
		guardRemote := remote
		if guardRemote == nil {
			guardRemote = vault.NewEmpty()
		}
		if pending := merge.Guard(local, guardRemote, merged, remoteVersion); pending != nil && !merge.Covers(opts.Confirmation, pending) {
			err := e.update(func(s *store.State) { s.Sync.Status, s.Sync.PendingConfirmation = StatusNeedsConfirmation, pending })
			return Result{Status: StatusNeedsConfirmation, Pending: pending}, err
		}

		// Upload.
		version := int64(0)
		if remoteVersion != nil {
			version = *remoteVersion
		}
		uploaded := false
		if remote == nil || !vault.Equal(merged, remote) || (rolledBack && opts.Recovery == UseLocal) {
			seq := lastSeq
			if remote != nil && remote.Seq > seq {
				seq = remote.Seq
			}
			seq++
			merged.Seq, merged.WrittenBy, merged.WrittenAt = seq, ss.DeviceID, float64(e.opts.Now().UnixMilli())
			plain, err := vault.Marshal(merged)
			if err != nil {
				return Result{}, err
			}
			env, err := crypto.SealVault(plain, ss.VaultKey, ss.Username)
			if err != nil {
				return Result{}, err
			}
			put, err := c.PutVault(ctx, env, version)
			if err != nil {
				return Result{}, e.checkAuth(err, ss.DeviceToken)
			}
			if put.Conflict {
				continue // someone else wrote; merge with the newer vault
			}
			version, lastSeq, uploaded = put.Version, seq, true
		} else if remote.Seq > lastSeq {
			lastSeq = remote.Seq
		}

		// Commit, atomically and only if the user did not edit meanwhile.
		if e.beforeCommit != nil {
			if err := e.beforeCommit(); err != nil {
				return Result{}, err
			}
		}
		committed := false
		changed := !vault.Equal(local, merged)
		err = e.update(func(s *store.State) {
			if s.LocalRev != snap.localRev || s.Session == nil || s.Session.DeviceToken != ss.DeviceToken {
				return
			}
			committed = true
			s.Local = merged.Clone()
			s.Sync.Base = merged
			s.Sync.Version, s.Sync.LastSeq = version, lastSeq
			s.Sync.PendingConfirmation, s.Sync.Rollback = nil, nil
			s.Sync.Status, s.Sync.LastError = StatusOK, ""
			s.Sync.LastSyncAt = e.opts.Now().UnixMilli()
		})
		if err != nil {
			return Result{}, err
		}
		if !committed {
			continue // edited (or signed out) meanwhile: merge again
		}
		return Result{Status: StatusOK, Uploaded: uploaded, Version: version, Changed: changed}, nil
	}
	err := e.update(func(s *store.State) { s.Sync.Status = StatusConflictExhausted })
	return Result{Status: StatusConflictExhausted, RetryAfterMs: (30 * time.Second).Milliseconds()}, err
}

// checkAuth turns a 401 into the signed-out state (only the token and vault
// key go) and passes other errors through.
func (e *Engine) checkAuth(err error, token string) error {
	if isUnauthorized(err) {
		e.unauthorized(token)
	}
	return err
}

func ptr[T any](v T) *T { return &v }
