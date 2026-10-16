// Package testserver runs the real BookSync server (internal/api over a
// SQLite database in a temp dir) for client tests. There are no API mocks:
// clients are tested against the same handlers the server ships.
package testserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	serverapi "github.com/FulgerX2007/BookSync/internal/api"
	"github.com/FulgerX2007/BookSync/internal/auth"
	"github.com/FulgerX2007/BookSync/internal/config"
	"github.com/FulgerX2007/BookSync/internal/store"
)

// Server is a running test server.
type Server struct {
	*httptest.Server
	Store *store.Store
}

// Start runs a server until the test ends. mutate adjusts the configuration.
func Start(t testing.TB, mutate ...func(*config.Config)) *Server {
	t.Helper()
	cfg := config.Default()
	for _, m := range mutate {
		m(&cfg)
	}
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "server.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	h := serverapi.NewServer(cfg, serverapi.Deps{Store: st, Hasher: auth.NewTestHasher()})
	srv := httptest.NewServer(h)
	t.Cleanup(func() {
		srv.Close()
		_ = st.Close()
	})
	return &Server{Server: srv, Store: st}
}

// Counter wraps a transport and counts requests by "METHOD path".
type Counter struct {
	Next  http.RoundTripper
	Count map[string]int
	// Before, when set, runs before each request is sent; returning a
	// non-nil response or error short-circuits it (fault injection).
	Before func(*http.Request) (*http.Response, error)
	// After, when set, runs after each response arrives.
	After func(*http.Request, *http.Response)
}

// RoundTrip implements http.RoundTripper.
func (c *Counter) RoundTrip(r *http.Request) (*http.Response, error) {
	if c.Count == nil {
		c.Count = make(map[string]int)
	}
	c.Count[r.Method+" "+r.URL.Path]++
	if c.Before != nil {
		if resp, err := c.Before(r); resp != nil || err != nil {
			return resp, err
		}
	}
	next := c.Next
	if next == nil {
		next = http.DefaultTransport
	}
	resp, err := next.RoundTrip(r)
	if err == nil && c.After != nil {
		c.After(r, resp)
	}
	return resp, err
}
