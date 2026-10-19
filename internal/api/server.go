// Package api implements the BookSync HTTP API.
package api

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/FulgerX2007/BookSync/internal/auth"
	"github.com/FulgerX2007/BookSync/internal/config"
	"github.com/FulgerX2007/BookSync/internal/store"
)

// Deps are the collaborators the HTTP layer needs.
type Deps struct {
	Logger *slog.Logger
	Store  *store.Store
	Hasher *auth.Hasher
	// Now is the clock used for token expiry; defaults to time.Now.
	Now func() time.Time
	// Version is the server build version shown to clients; defaults to "dev".
	Version string
}

// Server routes and serves API requests.
type Server struct {
	cfg  config.Config
	deps Deps
	log  *slog.Logger
	mux  *http.ServeMux

	authIPLimiter *keyedLimiter
	loginLimiter  *keyedLimiter
}

// NewServer builds the API handler.
func NewServer(cfg config.Config, deps Deps) http.Handler {
	log := deps.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.Version == "" {
		deps.Version = "dev"
	}
	s := &Server{
		cfg:           cfg,
		deps:          deps,
		log:           log,
		mux:           http.NewServeMux(),
		authIPLimiter: newKeyedLimiter(authIPRate, authIPBurst, deps.Now),
		loginLimiter:  newKeyedLimiter(loginUserIPRate, loginUserIPBurst, deps.Now),
	}
	s.routes()
	return s.recoverPanics(s.logRequests(http.HandlerFunc(s.dispatch)))
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", s.handleHealth)
	s.mux.HandleFunc("GET /{$}", s.handleHome)
	s.mux.HandleFunc("GET /v1/info", s.handleInfo)
	s.mux.HandleFunc("GET /v1/auth/prelogin", s.limitByIP(s.handlePrelogin))
	s.mux.HandleFunc("POST /v1/auth/register", s.limitByIP(s.handleRegister))
	s.mux.HandleFunc("POST /v1/auth/login", s.limitByIP(s.handleLogin))
	s.mux.HandleFunc("POST /v1/auth/logout", s.requireDevice(s.handleLogout))
	s.mux.HandleFunc("GET /v1/devices", s.requireDevice(s.handleListDevices))
	s.mux.HandleFunc("DELETE /v1/devices/{id}", s.requireDevice(s.handleRevokeDevice))
	s.mux.HandleFunc("POST /v1/account/password", s.requireDevice(s.handleChangePassword))
	s.mux.HandleFunc("POST /v1/account/delete", s.requireDevice(s.handleDeleteAccount))
	s.mux.HandleFunc("GET /v1/account/usage", s.requireDevice(s.handleUsage))
	s.mux.HandleFunc("GET /v1/vault", s.requireDevice(s.handleGetVault))
	s.mux.HandleFunc("PUT /v1/vault", s.requireDevice(s.handlePutVault))
	s.mux.HandleFunc("GET /v1/vault/versions", s.requireDevice(s.handleListVaultVersions))
	s.mux.HandleFunc("GET /v1/vault/versions/{version}", s.requireDevice(s.handleGetVaultVersion))
}

// internalError logs err and answers with a generic 500.
func (s *Server) internalError(w http.ResponseWriter, r *http.Request, err error) {
	s.log.ErrorContext(r.Context(), "internal error", "err", err, "method", r.Method, "path", r.URL.Path)
	writeError(w, http.StatusInternalServerError, codeInternal, "internal error")
}

// dispatch serves matched routes through the mux and turns the mux's
// plain-text 404/405 replies into the JSON error envelope.
func (s *Server) dispatch(w http.ResponseWriter, r *http.Request) {
	h, pattern := s.mux.Handler(r)
	if pattern != "" {
		// ServeHTTP (not h) so that path values are populated.
		s.mux.ServeHTTP(w, r)
		return
	}
	rec := &headerRecorder{header: http.Header{}, status: http.StatusNotFound}
	h.ServeHTTP(rec, r)
	switch rec.status {
	case http.StatusMethodNotAllowed:
		w.Header().Set("Allow", rec.header.Get("Allow"))
		writeError(w, http.StatusMethodNotAllowed, codeMethodNotAllowed, "method not allowed")
	case http.StatusNotFound:
		writeError(w, http.StatusNotFound, codeNotFound, "not found")
	default:
		// Redirects (e.g. trailing-slash canonicalization) pass through.
		for k, v := range rec.header {
			w.Header()[k] = v
		}
		w.WriteHeader(rec.status)
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if !s.storageOK(r.Context()) {
		writeError(w, http.StatusServiceUnavailable, codeUnavailable, "storage unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// logRequests logs every request; successful ones at debug level so that
// routine polling does not flood the log.
func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		level := slog.LevelDebug
		switch {
		case sw.status >= 500:
			level = slog.LevelError
		case sw.status >= 400:
			level = slog.LevelInfo
		}
		s.log.LogAttrs(r.Context(), level, "request",
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Int("status", sw.status),
			slog.Duration("duration", time.Since(start)),
		)
	})
}

// recoverPanics turns a handler panic into a 500 instead of a dropped connection.
func (s *Server) recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if err, ok := v.(error); ok && errors.Is(err, http.ErrAbortHandler) {
					panic(v)
				}
				s.log.Error("handler panic", "panic", v, "path", r.URL.Path)
				writeError(w, http.StatusInternalServerError, codeInternal, "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *statusWriter) WriteHeader(status int) {
	if !w.wroteHeader {
		w.status = status
		w.wroteHeader = true
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	w.wroteHeader = true
	return w.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// headerRecorder captures status and headers of the mux's fallback handlers.
type headerRecorder struct {
	header http.Header
	status int
}

func (r *headerRecorder) Header() http.Header         { return r.header }
func (r *headerRecorder) Write(b []byte) (int, error) { return len(b), nil }
func (r *headerRecorder) WriteHeader(status int)      { r.status = status }
