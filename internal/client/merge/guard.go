package merge

import "github.com/FulgerX2007/BookSync/internal/client/vault"

// Guard thresholds (protocol §4.6).
const (
	GuardMinDeletions = 20
	GuardFraction     = 0.25
)

// Pending is a merge waiting for the user (PendingConfirmation in the
// extension). RemoteVersion is nil when the server had no vault.
type Pending struct {
	RemoteVersion     *int64 `json:"remoteVersion"`
	DeletionsToLocal  int    `json:"deletionsToLocal"`
	DeletionsToRemote int    `json:"deletionsToRemote"`
}

func excessive(deletions, total int) bool {
	return deletions >= GuardMinDeletions && float64(deletions) > float64(total)*GuardFraction
}

// Guard returns the summary to confirm, or nil when the sync may proceed.
// remoteVersion identifies the server state the merge was made against.
func Guard(local, remote, merged *vault.Doc, remoteVersion *int64) *Pending {
	toLocal := vault.DiffStats(local, merged).Deletes
	toRemote := vault.DiffStats(remote, merged).Deletes
	if !excessive(toLocal, local.CountNodes()) && !excessive(toRemote, remote.CountNodes()) {
		return nil
	}
	return &Pending{RemoteVersion: remoteVersion, DeletionsToLocal: toLocal, DeletionsToRemote: toRemote}
}

// Covers reports whether a confirmation covers a pending merge: only for the
// same server version and at most the confirmed deletions in each direction.
func Covers(confirmed, pending *Pending) bool {
	return confirmed != nil && sameVersion(confirmed.RemoteVersion, pending.RemoteVersion) &&
		pending.DeletionsToLocal <= confirmed.DeletionsToLocal &&
		pending.DeletionsToRemote <= confirmed.DeletionsToRemote
}

func sameVersion(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
