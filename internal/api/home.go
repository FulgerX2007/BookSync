package api

import (
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"strings"
)

// The home page is rendered by the server and runs no JavaScript. Its CSS
// lives in home.css and is inserted as template.CSS, which html/template
// emits verbatim, so the CSP can pin those exact bytes by hash. (Hashing a
// literal <style> block in home.html would not work: html/template strips
// comments from literal text.) Inline style="…" attributes are not allowed.

//go:embed home.html
var homeHTML string

//go:embed home.css
var homeCSS string

var (
	homeTemplate = template.Must(template.New("home").Parse(homeHTML))
	homeCSP      = func() string {
		sum := sha256.Sum256([]byte(homeCSS))
		return "default-src 'none'; style-src 'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) +
			"'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
	}()
)

type endpointRow struct {
	Method, Path, Auth, Purpose string
}

// Class is the CSS class of the method badge.
func (e endpointRow) Class() string { return "m-" + strings.ToLower(e.Method) }

// homeEndpoints mirrors docs/protocol.md §3.2.
var homeEndpoints = []endpointRow{
	{"GET", "/v1/info", "–", "Service, version, status and limits"},
	{"GET", "/healthz", "–", "Health check"},
	{"GET", "/v1/auth/prelogin", "–", "Key-derivation parameters for a username"},
	{"POST", "/v1/auth/register", "–", "Create an account and its first device"},
	{"POST", "/v1/auth/login", "–", "Register this browser as a device"},
	{"POST", "/v1/auth/logout", "device", "Sign this device out"},
	{"GET", "/v1/devices", "device", "List the account's devices"},
	{"DELETE", "/v1/devices/{id}", "device", "Sign another device out"},
	{"POST", "/v1/account/password", "device", "Change the password, optionally rotating keys"},
	{"POST", "/v1/account/delete", "device", "Delete the account and its data"},
	{"GET", "/v1/account/usage", "device", "Vault size and this account's limit"},
	{"GET", "/v1/vault", "device", "Download the encrypted vault"},
	{"PUT", "/v1/vault", "device", "Upload a new vault version"},
	{"GET", "/v1/vault/versions", "device", "List stored versions"},
	{"GET", "/v1/vault/versions/{version}", "device", "Download one stored version"},
}

type homeView struct {
	CSS        template.CSS
	Info       serverInfo
	Online     bool
	ServerURL  string
	NeedsHTTPS bool
	MaxVault   string
	Endpoints  []endpointRow
}

// handleHome serves the service-info page. It answers 200 even when storage
// is down: the page reports that itself. net/http drops the body for HEAD.
func (s *Server) handleHome(w http.ResponseWriter, r *http.Request) {
	info := s.info(r.Context())
	scheme := s.requestScheme(r)
	view := homeView{
		CSS:        template.CSS(homeCSS), //nolint:gosec // constant embedded stylesheet, pinned by the CSP hash
		Info:       info,
		Online:     info.Status == "ok",
		ServerURL:  scheme + "://" + r.Host,
		NeedsHTTPS: scheme == "http" && !isLocalHost(r.Host),
		MaxVault:   formatBytes(info.MaxVaultBytes),
		Endpoints:  homeEndpoints,
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", homeCSP)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if err := homeTemplate.Execute(w, view); err != nil {
		// Headers are sent; only a broken connection or a template bug gets here.
		s.log.ErrorContext(r.Context(), "render home page", "err", err)
	}
}

// requestScheme is the scheme the client used: TLS on this connection, or
// the first X-Forwarded-Proto entry when a trusted proxy terminates TLS.
func (s *Server) requestScheme(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	if s.cfg.TrustProxyHeaders {
		first, _, _ := strings.Cut(r.Header.Get("X-Forwarded-Proto"), ",")
		if p := strings.ToLower(strings.TrimSpace(first)); p == "https" || p == "http" {
			return p
		}
	}
	return "http"
}

// isLocalHost reports whether a Host header names this machine, where the
// extension accepts plain http.
func isLocalHost(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	return strings.EqualFold(host, "localhost") || host == "127.0.0.1" || host == "::1"
}

// formatBytes renders a size in binary units, e.g. 10485760 → "10 MiB".
func formatBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	v := float64(n) / float64(div)
	if v == float64(int64(v)) {
		return fmt.Sprintf("%d %ciB", int64(v), "KMGTPE"[exp])
	}
	return fmt.Sprintf("%.1f %ciB", v, "KMGTPE"[exp])
}
