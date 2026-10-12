package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/config"
)

func decodeError(t *testing.T, rec *httptest.ResponseRecorder) errorDetail {
	t.Helper()
	var body errorResponse
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode error body %q: %v", rec.Body.String(), err)
	}
	return body.Error
}

func TestHealthz(t *testing.T) {
	h := NewServer(config.Default(), Deps{})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q", ct)
	}
}

func TestHealthzStorageDown(t *testing.T) {
	e := newTestEnv(t)
	_ = e.st.Close()
	rec := e.do(http.MethodGet, "/healthz", nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if got := decodeError(t, rec).Code; got != codeUnavailable {
		t.Fatalf("code = %q", got)
	}
}

func TestUnknownRouteIsJSON404(t *testing.T) {
	h := NewServer(config.Default(), Deps{})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if got := decodeError(t, rec).Code; got != codeNotFound {
		t.Fatalf("code = %q", got)
	}
}

func TestWrongMethodIsJSON405(t *testing.T) {
	h := NewServer(config.Default(), Deps{})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/healthz", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
	if allow := rec.Header().Get("Allow"); allow == "" {
		t.Fatal("missing Allow header")
	}
	if got := decodeError(t, rec).Code; got != codeMethodNotAllowed {
		t.Fatalf("code = %q", got)
	}
}

func TestPanicBecomes500(t *testing.T) {
	s := &Server{log: discardLogger(), mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /boom", func(http.ResponseWriter, *http.Request) { panic("boom") })
	h := s.recoverPanics(http.HandlerFunc(s.dispatch))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/boom", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if got := decodeError(t, rec).Code; got != codeInternal {
		t.Fatalf("code = %q", got)
	}
}
