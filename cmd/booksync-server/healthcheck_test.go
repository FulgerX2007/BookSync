package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProbe(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	defer ok.Close()
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer failing.Close()
	gone := httptest.NewServer(http.NotFoundHandler())
	goneURL := gone.URL
	gone.Close()

	if err := probe(context.Background(), ok.URL+"/healthz"); err != nil {
		t.Fatalf("healthy server: %v", err)
	}
	if err := probe(context.Background(), failing.URL+"/healthz"); err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("503 server: err = %v", err)
	}
	if err := probe(context.Background(), goneURL+"/healthz"); err == nil {
		t.Fatal("unreachable server reported healthy")
	}
}

func TestHealthcheckURL(t *testing.T) {
	tests := map[string]string{
		":8080":          "http://127.0.0.1:8080/healthz",
		"0.0.0.0:9000":   "http://127.0.0.1:9000/healthz",
		"[::]:9000":      "http://127.0.0.1:9000/healthz",
		"10.0.0.5:8080":  "http://10.0.0.5:8080/healthz",
		"localhost:7000": "http://localhost:7000/healthz",
		"garbage":        "http://127.0.0.1:8080/healthz",
	}
	for addr, want := range tests {
		if got := healthcheckURL(addr); got != want {
			t.Errorf("healthcheckURL(%q) = %q, want %q", addr, got, want)
		}
	}
}

func TestHealthcheckUsesConfiguredAddr(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	addr := strings.TrimPrefix(srv.URL, "http://")
	if err := healthcheck(context.Background(), testEnv(map[string]string{"BOOKSYNC_ADDR": addr})); err != nil {
		t.Fatalf("healthcheck: %v", err)
	}
	if err := healthcheck(context.Background(), testEnv(map[string]string{"BOOKSYNC_TOKEN_TTL": "bad"})); err == nil {
		t.Fatal("invalid config accepted")
	}
}
