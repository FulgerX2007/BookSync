package api

import (
	"context"
	"net/http"
	"time"
)

// protocolVersion is the major version of docs/protocol.md ("BookSync protocol, v1").
const protocolVersion = 1

// serverInfo describes this server to clients (GET /v1/info) and to people
// (the home page). It holds nothing that is not already observable.
type serverInfo struct {
	Service          string `json:"service"`
	Protocol         int    `json:"protocol"`
	Version          string `json:"version"`
	Status           string `json:"status"` // "ok" or "unavailable"
	RegistrationOpen bool   `json:"registrationOpen"`
	MaxVaultBytes    int64  `json:"maxVaultBytes"`
}

// storageOK pings the store, logging a failure. A server without a store
// (some tests) counts as healthy.
func (s *Server) storageOK(ctx context.Context) bool {
	if s.deps.Store == nil {
		return true
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := s.deps.Store.Ping(ctx); err != nil {
		s.log.Error("health check failed", "err", err)
		return false
	}
	return true
}

func (s *Server) info(ctx context.Context) serverInfo {
	status := "ok"
	if !s.storageOK(ctx) {
		status = "unavailable"
	}
	return serverInfo{
		Service:          "booksync",
		Protocol:         protocolVersion,
		Version:          s.deps.Version,
		Status:           status,
		RegistrationOpen: s.cfg.AllowRegistration,
		MaxVaultBytes:    s.cfg.MaxVaultBytes,
	}
}

// handleInfo always answers 200: a client probing a server wants the facts,
// including that its storage is down.
func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.info(r.Context()))
}
