package api

import (
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/config"
)

func TestHomePage(t *testing.T) {
	tests := []struct {
		name    string
		deps    func(*Deps)
		mutate  func(*config.Config)
		want    []string
		notWant []string
	}{
		{
			name: "online with sign-up open",
			deps: func(d *Deps) { d.Version = "1.2.3" },
			want: []string{`<span class="pill ok">Online</span>`, "<dd>1.2.3</dd>", "<dd>Open</dd>", "<dd>10 MiB</dd>", "Create an account, or sign in", "/v1/vault/versions/{version}"},
		},
		{
			name:    "sign-up closed",
			mutate:  func(c *config.Config) { c.AllowRegistration = false },
			want:    []string{"<dd>Closed</dd>", "Sign-up is closed on this server."},
			notWant: []string{"Create an account, or sign in"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var mutate []func(*config.Config)
			if tt.mutate != nil {
				mutate = append(mutate, tt.mutate)
			}
			e := newTestEnvDeps(t, tt.deps, mutate...)
			rec := e.do(http.MethodGet, "/", nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", rec.Code)
			}
			if ct := rec.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
				t.Fatalf("content-type = %q", ct)
			}
			csp := rec.Header().Get("Content-Security-Policy")
			if !strings.HasPrefix(csp, "default-src 'none'; style-src 'sha256-") || strings.Contains(csp, "script-src") {
				t.Fatalf("CSP = %q", csp)
			}
			for _, h := range []string{"X-Content-Type-Options", "Referrer-Policy", "Cache-Control"} {
				if rec.Header().Get(h) == "" {
					t.Errorf("missing %s", h)
				}
			}
			body := rec.Body.String()
			for _, s := range tt.want {
				if !strings.Contains(body, s) {
					t.Errorf("body lacks %q", s)
				}
			}
			for _, s := range tt.notWant {
				if strings.Contains(body, s) {
					t.Errorf("body contains %q", s)
				}
			}
		})
	}
}

// The CSP pins the stylesheet by hash; it must match the bytes served.
func TestHomePageCSPMatchesServedStyle(t *testing.T) {
	e := newTestEnv(t)
	rec := e.do(http.MethodGet, "/", nil)
	m := regexp.MustCompile(`(?s)<style>(.*?)</style>`).FindStringSubmatch(rec.Body.String())
	if m == nil {
		t.Fatal("no <style> block")
	}
	sum := sha256.Sum256([]byte(m[1]))
	want := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, want) {
		t.Fatalf("CSP %q lacks %s", csp, want)
	}
	if strings.Contains(rec.Body.String(), "style=") {
		t.Fatal("inline style attributes are blocked by the CSP")
	}
	if strings.Contains(rec.Body.String(), "<script") {
		t.Fatal("the home page must not contain scripts")
	}
}

func TestHomePageStorageDown(t *testing.T) {
	e := newTestEnv(t)
	_ = e.st.Close()
	rec := e.do(http.MethodGet, "/", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `<span class="pill bad">Storage unavailable</span>`) {
		t.Fatal("page does not report the storage failure")
	}
}

// ResponseRecorder keeps HEAD bodies; the real server drops them.
func TestHomePageHead(t *testing.T) {
	e := newTestEnv(t)
	srv := httptest.NewServer(e.h)
	defer srv.Close()
	resp, err := http.Head(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || len(body) != 0 {
		t.Fatalf("HEAD / = %d with %d body bytes", resp.StatusCode, len(body))
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Fatalf("content-type = %q", ct)
	}
}

func TestHomeRouteIsRootOnly(t *testing.T) {
	e := newTestEnv(t)
	if rec := e.do(http.MethodGet, "/nope", nil); rec.Code != http.StatusNotFound || decodeError(t, rec).Code != codeNotFound {
		t.Fatalf("GET /nope = %d", rec.Code)
	}
	rec := e.do(http.MethodPost, "/", nil)
	if rec.Code != http.StatusMethodNotAllowed || decodeError(t, rec).Code != codeMethodNotAllowed {
		t.Fatalf("POST / = %d", rec.Code)
	}
	if allow := rec.Header().Get("Allow"); allow != "GET, HEAD" {
		t.Fatalf("Allow = %q", allow)
	}
}

func TestHomePageServerAddress(t *testing.T) {
	const httpsWarning = "The extension requires HTTPS"
	tests := []struct {
		name      string
		trust     bool
		host      string
		hdr       []string
		wantURL   string
		wantWarn  bool
		wantInURL string
	}{
		{name: "plain http on a public host warns", host: "sync.example.com", wantURL: "http://sync.example.com", wantWarn: true},
		{name: "localhost needs no TLS", host: "localhost:8080", wantURL: "http://localhost:8080"},
		{name: "IPv6 loopback needs no TLS", host: "[::1]:8080", wantURL: "http://[::1]:8080"},
		{name: "untrusted X-Forwarded-Proto is ignored", host: "sync.example.com", hdr: []string{"X-Forwarded-Proto", "https"}, wantURL: "http://sync.example.com", wantWarn: true},
		{name: "trusted proxy: first entry wins", trust: true, host: "sync.example.com", hdr: []string{"X-Forwarded-Proto", "https, http"}, wantURL: "https://sync.example.com"},
		{name: "trusted proxy: junk is ignored", trust: true, host: "sync.example.com", hdr: []string{"X-Forwarded-Proto", "gopher"}, wantURL: "http://sync.example.com", wantWarn: true},
		{name: "a hostile Host header is escaped", host: `x"><script>alert(1)</script>`, wantInURL: "&lt;script&gt;", wantWarn: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newTestEnv(t, func(c *config.Config) { c.TrustProxyHeaders = tt.trust })
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.Host = tt.host
			for i := 0; i+1 < len(tt.hdr); i += 2 {
				req.Header.Set(tt.hdr[i], tt.hdr[i+1])
			}
			rec := httptest.NewRecorder()
			e.h.ServeHTTP(rec, req)
			body := rec.Body.String()
			m := regexp.MustCompile(`<code class="address">([^<]*)</code>`).FindStringSubmatch(body)
			if m == nil {
				t.Fatalf("no address in page")
			}
			if tt.wantURL != "" && m[1] != tt.wantURL {
				t.Errorf("address = %q, want %q", m[1], tt.wantURL)
			}
			if tt.wantInURL != "" && !strings.Contains(m[1], tt.wantInURL) {
				t.Errorf("address = %q, want it to contain %q", m[1], tt.wantInURL)
			}
			if strings.Contains(body, "<script") {
				t.Error("Host header was not escaped")
			}
			if got := strings.Contains(body, httpsWarning); got != tt.wantWarn {
				t.Errorf("HTTPS warning shown = %v, want %v", got, tt.wantWarn)
			}
		})
	}
}

func TestFormatBytes(t *testing.T) {
	tests := []struct {
		in   int64
		want string
	}{
		{0, "0 B"},
		{1023, "1023 B"},
		{1024, "1 KiB"},
		{1536, "1.5 KiB"},
		{10 << 20, "10 MiB"},
		{3 << 30, "3 GiB"},
	}
	for _, tt := range tests {
		if got := formatBytes(tt.in); got != tt.want {
			t.Errorf("formatBytes(%d) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
