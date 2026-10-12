package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/FulgerX2007/BookSync/internal/auth"
	"github.com/FulgerX2007/BookSync/internal/store"
)

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	d := currentDevice(r)
	if err := s.deps.Store.DeleteDevice(r.Context(), d.UserID, d.ID); err != nil && !errors.Is(err, store.ErrNotFound) {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type deviceResponse struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
	Current    bool      `json:"current"`
}

func (s *Server) handleListDevices(w http.ResponseWriter, r *http.Request) {
	current := currentDevice(r)
	devices, err := s.deps.Store.ListDevices(r.Context(), current.UserID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := make([]deviceResponse, 0, len(devices))
	for _, d := range devices {
		out = append(out, deviceResponse{
			ID:         d.ID,
			Name:       d.Name,
			CreatedAt:  d.CreatedAt,
			LastSeenAt: d.LastSeenAt,
			Current:    d.ID == current.ID,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleRevokeDevice(w http.ResponseWriter, r *http.Request) {
	current := currentDevice(r)
	err := s.deps.Store.DeleteDevice(r.Context(), current.UserID, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, codeNotFound, "device not found")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type deleteAccountRequest struct {
	AuthKey b64 `json:"authKey"`
}

// handleDeleteAccount removes the user and, by cascade, every device and
// vault version. It re-checks the auth key so a stolen device token alone
// cannot destroy the account.
func (s *Server) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	var req deleteAccountRequest
	if !decodeJSON(w, r, &req, maxJSONBody) {
		return
	}
	u, ok := s.reauthenticate(w, r, req.AuthKey)
	if !ok {
		return
	}
	if err := s.deps.Store.DeleteUser(r.Context(), u.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.log.Info("account deleted", "user", u.ID)
	w.WriteHeader(http.StatusNoContent)
}

// reauthenticate verifies authKey for the current device's user.
func (s *Server) reauthenticate(w http.ResponseWriter, r *http.Request, authKey []byte) (store.User, bool) {
	u, err := s.deps.Store.UserByID(r.Context(), currentDevice(r).UserID)
	if err != nil {
		s.internalError(w, r, err)
		return store.User{}, false
	}
	ok, err := s.deps.Hasher.Verify(r.Context(), authKey, u.AuthHash, u.AuthSalt)
	if err != nil {
		s.internalError(w, r, err)
		return store.User{}, false
	}
	if !ok {
		writeError(w, http.StatusUnauthorized, codeInvalidCredentials, "password or SyncID is incorrect")
		return store.User{}, false
	}
	return u, true
}

type rotationRequest struct {
	ExpectedVersion int64 `json:"expectedVersion"`
	Vault           b64   `json:"vault"`
}

type changePasswordRequest struct {
	CurrentAuthKey     b64              `json:"currentAuthKey"`
	NewAuthKey         b64              `json:"newAuthKey"`
	KDF                string           `json:"kdf"`
	Iterations         int              `json:"iterations"`
	NewWrappedVaultKey b64              `json:"newWrappedVaultKey"`
	Rotation           *rotationRequest `json:"rotation,omitempty"`
}

// handleChangePassword replaces the credentials and signs out every other
// device. With "rotation" it also replaces the vault history with a vault
// re-encrypted under a new vault key ("a device was lost").
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var req changePasswordRequest
	// Room for a base64url vault of up to MaxVaultBytes plus the JSON fields.
	limit := maxJSONBody + (s.cfg.MaxVaultBytes*4+2)/3
	if !decodeJSON(w, r, &req, limit) {
		return
	}
	if err := auth.ValidateAuthKey(req.NewAuthKey); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "newAuthKey must be 32 bytes")
		return
	}
	if err := validateKDF(req.KDF, req.Iterations); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}
	if err := validateWrappedKey(req.NewWrappedVaultKey); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}
	var rot *store.VaultRotation
	if req.Rotation != nil {
		if int64(len(req.Rotation.Vault)) > s.cfg.MaxVaultBytes {
			writeError(w, http.StatusRequestEntityTooLarge, codeVaultTooLarge, "vault exceeds the server's size limit")
			return
		}
		if !validVaultEnvelope(req.Rotation.Vault) || req.Rotation.ExpectedVersion < 0 {
			writeError(w, http.StatusBadRequest, codeInvalidVault, "rotation.vault is not a BookSync vault envelope")
			return
		}
		rot = &store.VaultRotation{Expected: req.Rotation.ExpectedVersion, Ciphertext: req.Rotation.Vault}
	}

	u, ok := s.reauthenticate(w, r, req.CurrentAuthKey)
	if !ok {
		return
	}
	hash, salt, err := s.deps.Hasher.Hash(r.Context(), req.NewAuthKey)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	version, err := s.deps.Store.ChangeCredentials(r.Context(), u.ID, currentDevice(r).ID, store.Credentials{
		AuthHash:        hash,
		AuthSalt:        salt,
		KDF:             req.KDF,
		KDFIterations:   req.Iterations,
		WrappedVaultKey: req.NewWrappedVaultKey,
	}, rot)
	var conflict *store.VersionConflictError
	if errors.As(err, &conflict) {
		writeJSON(w, http.StatusPreconditionFailed, conflictResponse{Error: conflictDetail{
			Code:           codeVersionConflict,
			Message:        "the vault changed since it was read; sync and retry",
			CurrentVersion: conflict.Current,
		}})
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.log.Info("credentials changed", "user", u.ID, "rotated", rot != nil)
	if rot == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("ETag", etag(version))
	writeJSON(w, http.StatusOK, putVaultResponse{Version: version})
}
