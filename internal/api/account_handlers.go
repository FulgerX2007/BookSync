package api

import (
	"errors"
	"net/http"
	"time"

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
