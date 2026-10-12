package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/FulgerX2007/BookSync/internal/auth"
	"github.com/FulgerX2007/BookSync/internal/store"
)

const codeUnauthorized = "unauthorized"

// touchInterval limits last-seen/expiry writes to one per device per hour.
const touchInterval = time.Hour

type ctxKey int

const deviceCtxKey ctxKey = iota

// requireDevice authenticates the request's bearer token and puts the
// device in the context. Missing, malformed, unknown, revoked and expired
// tokens all get the same 401.
func (s *Server) requireDevice(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		d, ok := s.authenticate(w, r)
		if !ok {
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), deviceCtxKey, d)))
	}
}

func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (store.Device, bool) {
	unauthorized := func() (store.Device, bool) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="booksync"`)
		writeError(w, http.StatusUnauthorized, codeUnauthorized, "missing, invalid or expired device token")
		return store.Device{}, false
	}
	token, ok := bearerToken(r.Header.Get("Authorization"))
	if !ok {
		return unauthorized()
	}
	hash, err := auth.HashToken(token)
	if err != nil {
		return unauthorized()
	}
	d, err := s.deps.Store.DeviceByTokenHash(r.Context(), hash)
	if errors.Is(err, store.ErrNotFound) {
		return unauthorized()
	}
	if err != nil {
		s.internalError(w, r, err)
		return store.Device{}, false
	}
	now := s.deps.Now()
	if !now.Before(d.ExpiresAt) {
		return unauthorized()
	}
	if now.Sub(d.LastSeenAt) >= touchInterval {
		// Failing to slide the expiry must not fail the request.
		if err := s.deps.Store.TouchDevice(r.Context(), d.ID, s.cfg.TokenTTL); err != nil {
			s.log.WarnContext(r.Context(), "touch device failed", "device", d.ID, "err", err)
		}
	}
	return d, true
}

// bearerToken extracts the token from an Authorization header. The scheme
// name is case-insensitive (RFC 9110).
func bearerToken(header string) (string, bool) {
	scheme, token, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	return token, token != ""
}

// currentDevice returns the authenticated device. Only valid inside handlers
// wrapped by requireDevice.
func currentDevice(r *http.Request) store.Device {
	d, _ := r.Context().Value(deviceCtxKey).(store.Device)
	return d
}
