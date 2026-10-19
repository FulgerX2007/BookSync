package api

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/FulgerX2007/BookSync/internal/store"
)

const (
	codeVaultEmpty           = "vault_empty"
	codeVaultTooLarge        = "vault_too_large"
	codeInvalidVault         = "invalid_vault"
	codeVersionConflict      = "version_conflict"
	codePreconditionRequired = "precondition_required"
)

// vaultMagic starts every vault envelope: "BSV1" ‖ iv(12) ‖ AES-GCM ciphertext+tag(≥16).
var vaultMagic = []byte("BSV1")

const minVaultSize = 4 + 12 + 16

func etag(version int64) string { return `"` + strconv.FormatInt(version, 10) + `"` }

// parseETag accepts a single strong entity tag holding a positive version.
func parseETag(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if len(s) < 3 || s[0] != '"' || s[len(s)-1] != '"' {
		return 0, false
	}
	v, err := strconv.ParseInt(s[1:len(s)-1], 10, 64)
	return v, err == nil && v > 0
}

// etagListMatches implements If-None-Match matching for a comma-separated
// list of entity tags (weak comparison, as RFC 9110 requires for GET).
func etagListMatches(header string, current int64) bool {
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimPrefix(strings.TrimSpace(part), "W/")
		if part == "*" {
			return true
		}
		if v, ok := parseETag(part); ok && v == current {
			return true
		}
	}
	return false
}

func (s *Server) handleGetVault(w http.ResponseWriter, r *http.Request) {
	v, err := s.deps.Store.LatestVault(r.Context(), currentDevice(r).UserID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, codeVaultEmpty, "no vault has been uploaded yet")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	w.Header().Set("ETag", etag(v.Version))
	w.Header().Set("Cache-Control", "no-store")
	if inm := r.Header.Get("If-None-Match"); inm != "" && etagListMatches(inm, v.Version) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeBlob(w, v.Ciphertext)
}

func writeBlob(w http.ResponseWriter, b []byte) {
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b)
}

type putVaultResponse struct {
	Version int64 `json:"version"`
}

type conflictResponse struct {
	Error conflictDetail `json:"error"`
}

type conflictDetail struct {
	Code           string `json:"code"`
	Message        string `json:"message"`
	CurrentVersion int64  `json:"currentVersion"`
}

// handlePutVault stores a new vault version with optimistic concurrency:
// the client must name the version it merged against (If-Match) or assert
// that no vault exists yet (If-None-Match: *).
func (s *Server) handlePutVault(w http.ResponseWriter, r *http.Request) {
	ifMatch, ifNoneMatch := r.Header.Get("If-Match"), strings.TrimSpace(r.Header.Get("If-None-Match"))
	var expected *int64
	switch {
	case ifMatch != "" && ifNoneMatch != "":
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "send either If-Match or If-None-Match, not both")
		return
	case ifMatch != "":
		v, ok := parseETag(ifMatch)
		if !ok {
			writeError(w, http.StatusBadRequest, codeInvalidRequest, `If-Match must be a single version tag like "3"`)
			return
		}
		expected = &v
	case ifNoneMatch == "*":
		// expected stays nil: the vault must not exist yet.
	default:
		writeError(w, http.StatusPreconditionRequired, codePreconditionRequired, `send If-Match: "<version>" or If-None-Match: *`)
		return
	}

	d := currentDevice(r)
	limit, err := s.vaultLimit(r, d.UserID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, codeVaultTooLarge, vaultTooLargeMessage)
			return
		}
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "could not read body")
		return
	}
	if !validVaultEnvelope(body) {
		writeError(w, http.StatusBadRequest, codeInvalidVault, "body is not a BookSync vault envelope")
		return
	}

	version, err := s.deps.Store.PutVault(r.Context(), d.UserID, d.ID, expected, body, s.retention())
	var conflict *store.VersionConflictError
	if errors.As(err, &conflict) {
		if conflict.Current > 0 {
			w.Header().Set("ETag", etag(conflict.Current))
		}
		writeJSON(w, http.StatusPreconditionFailed, conflictResponse{Error: conflictDetail{
			Code:           codeVersionConflict,
			Message:        "the vault changed since it was read; merge and retry",
			CurrentVersion: conflict.Current,
		}})
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	w.Header().Set("ETag", etag(version))
	writeJSON(w, http.StatusOK, putVaultResponse{Version: version})
}

const vaultTooLargeMessage = "vault exceeds this account's size limit"

// vaultLimit is the user's own vault size limit, or the server default.
func (s *Server) vaultLimit(r *http.Request, userID string) (int64, error) {
	limit, _, err := s.deps.Store.VaultUsage(r.Context(), userID)
	if err != nil {
		return 0, err
	}
	return s.effectiveLimit(limit), nil
}

func (s *Server) effectiveLimit(own int64) int64 {
	if own > 0 {
		return own
	}
	return s.cfg.MaxVaultBytes
}

type usageResponse struct {
	VaultBytes    int64 `json:"vaultBytes"`
	MaxVaultBytes int64 `json:"maxVaultBytes"`
}

// handleUsage reports the size of the current vault version and the
// account's limit, so clients can warn before an upload is refused.
func (s *Server) handleUsage(w http.ResponseWriter, r *http.Request) {
	own, size, err := s.deps.Store.VaultUsage(r.Context(), currentDevice(r).UserID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, usageResponse{VaultBytes: size, MaxVaultBytes: s.effectiveLimit(own)})
}

// validVaultEnvelope is a sanity check only; the server cannot decrypt.
func validVaultEnvelope(b []byte) bool {
	return len(b) >= minVaultSize && bytes.HasPrefix(b, vaultMagic)
}

func (s *Server) retention() store.Retention {
	return store.Retention{KeepRecent: s.cfg.VaultKeepRecent, KeepDays: s.cfg.VaultKeepDays}
}

type vaultVersionResponse struct {
	Version    int64     `json:"version"`
	CreatedAt  time.Time `json:"createdAt"`
	DeviceName string    `json:"deviceName"`
	Size       int64     `json:"size"`
}

func (s *Server) handleListVaultVersions(w http.ResponseWriter, r *http.Request) {
	versions, err := s.deps.Store.ListVaultVersions(r.Context(), currentDevice(r).UserID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := make([]vaultVersionResponse, 0, len(versions))
	for _, v := range versions {
		out = append(out, vaultVersionResponse{Version: v.Version, CreatedAt: v.CreatedAt, DeviceName: v.DeviceName, Size: v.Size})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleGetVaultVersion(w http.ResponseWriter, r *http.Request) {
	version, err := strconv.ParseInt(r.PathValue("version"), 10, 64)
	if err != nil || version < 1 {
		writeError(w, http.StatusNotFound, codeNotFound, "version not found")
		return
	}
	v, err := s.deps.Store.VaultVersion(r.Context(), currentDevice(r).UserID, version)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, codeNotFound, "version not found")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeBlob(w, v.Ciphertext)
}
