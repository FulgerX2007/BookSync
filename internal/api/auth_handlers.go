package api

import (
	"errors"
	"net/http"

	"github.com/FulgerX2007/BookSync/internal/auth"
	"github.com/FulgerX2007/BookSync/internal/store"
)

const (
	codeRegistrationClosed = "registration_closed"
	codeUsernameTaken      = "username_taken"
	codeInvalidCredentials = "invalid_credentials" //nolint:gosec // an error code, not a credential
)

type kdfParams struct {
	KDF        string `json:"kdf"`
	Iterations int    `json:"iterations"`
}

// sessionResponse is returned when a device signs in. Login additionally
// returns the wrapped vault key and KDF parameters.
type sessionResponse struct {
	UserID          string `json:"userId"`
	DeviceID        string `json:"deviceId"`
	DeviceToken     string `json:"deviceToken"`
	WrappedVaultKey b64    `json:"wrappedVaultKey,omitempty"`
	KDF             string `json:"kdf,omitempty"`
	Iterations      int    `json:"iterations,omitempty"`
}

// handlePrelogin returns the KDF parameters for a username. Unknown and
// invalid usernames get the defaults, so the endpoint does not reveal which
// accounts exist.
func (s *Server) handlePrelogin(w http.ResponseWriter, r *http.Request) {
	resp := kdfParams{KDF: kdfPBKDF2, Iterations: minKDFIterations}
	if username, ok := normalizeUsername(r.URL.Query().Get("username")); ok {
		u, err := s.deps.Store.UserByUsername(r.Context(), username)
		switch {
		case err == nil:
			resp = kdfParams{KDF: u.KDF, Iterations: u.KDFIterations}
		case !errors.Is(err, store.ErrNotFound):
			s.internalError(w, r, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

type registerRequest struct {
	Username        string `json:"username"`
	AuthKey         b64    `json:"authKey"`
	KDF             string `json:"kdf"`
	Iterations      int    `json:"iterations"`
	WrappedVaultKey b64    `json:"wrappedVaultKey"`
	DeviceName      string `json:"deviceName"`
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.AllowRegistration {
		writeError(w, http.StatusForbidden, codeRegistrationClosed, "registration is closed on this server")
		return
	}
	var req registerRequest
	if !decodeJSON(w, r, &req, maxJSONBody) {
		return
	}
	username, ok := normalizeUsername(req.Username)
	if !ok {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "username must be 3-64 characters of a-z, 0-9, '.', '_' or '-'")
		return
	}
	if err := auth.ValidateAuthKey(req.AuthKey); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "authKey must be 32 bytes")
		return
	}
	if err := validateKDF(req.KDF, req.Iterations); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}
	if err := validateWrappedKey(req.WrappedVaultKey); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}
	deviceName, err := normalizeDeviceName(req.DeviceName)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}

	hash, salt, err := s.deps.Hasher.Hash(r.Context(), req.AuthKey)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	token, tokenHash := auth.NewDeviceToken()
	u, d, err := s.deps.Store.Register(r.Context(),
		store.NewUser{
			Username:        username,
			AuthHash:        hash,
			AuthSalt:        salt,
			KDF:             req.KDF,
			KDFIterations:   req.Iterations,
			WrappedVaultKey: req.WrappedVaultKey,
		},
		store.NewDevice{Name: deviceName, TokenHash: tokenHash, TTL: s.cfg.TokenTTL},
	)
	if errors.Is(err, store.ErrUsernameTaken) {
		writeError(w, http.StatusConflict, codeUsernameTaken, "username is already taken")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.log.Info("user registered", "user", u.ID, "device", d.ID)
	writeJSON(w, http.StatusCreated, sessionResponse{UserID: u.ID, DeviceID: d.ID, DeviceToken: token})
}

type loginRequest struct {
	Username   string `json:"username"`
	AuthKey    b64    `json:"authKey"`
	DeviceName string `json:"deviceName"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if !decodeJSON(w, r, &req, maxJSONBody) {
		return
	}
	deviceName, err := normalizeDeviceName(req.DeviceName)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}
	if err := auth.ValidateAuthKey(req.AuthKey); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "authKey must be 32 bytes")
		return
	}

	u, ok := s.verifyLogin(w, r, req.Username, req.AuthKey)
	if !ok {
		return
	}
	token, tokenHash := auth.NewDeviceToken()
	d, err := s.deps.Store.CreateDevice(r.Context(), u.ID, store.NewDevice{Name: deviceName, TokenHash: tokenHash, TTL: s.cfg.TokenTTL})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, sessionResponse{
		UserID:          u.ID,
		DeviceID:        d.ID,
		DeviceToken:     token,
		WrappedVaultKey: u.WrappedVaultKey,
		KDF:             u.KDF,
		Iterations:      u.KDFIterations,
	})
}

// verifyLogin checks username + authKey. Unknown users cost the same hash
// work as real ones and get the same generic error.
func (s *Server) verifyLogin(w http.ResponseWriter, r *http.Request, rawUsername string, authKey []byte) (store.User, bool) {
	fail := func() (store.User, bool) {
		writeError(w, http.StatusUnauthorized, codeInvalidCredentials, "username, password or SyncID is incorrect")
		return store.User{}, false
	}
	username, valid := normalizeUsername(rawUsername)
	var u store.User
	var err error
	if valid {
		u, err = s.deps.Store.UserByUsername(r.Context(), username)
	}
	if !valid || errors.Is(err, store.ErrNotFound) {
		if err := s.deps.Hasher.DummyVerify(r.Context()); err != nil {
			s.internalError(w, r, err)
			return store.User{}, false
		}
		return fail()
	}
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
		return fail()
	}
	return u, true
}
