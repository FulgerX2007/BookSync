// Package api is the client for the BookSync server API (docs/protocol.md
// §3), mirroring extension/src/api/client.ts.
package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/FulgerX2007/BookSync/internal/client/crypto"
)

// Error codes (ApiErrorCode in the extension). Clients branch on them.
const (
	CodeUnauthorized       = "unauthorized"        // device token missing, revoked or expired
	CodeInvalidCredentials = "invalid_credentials" //nolint:gosec // an error code, not a credential
	CodeRateLimited        = "rate_limited"
	CodeVersionConflict    = "version_conflict"
	CodeTooLarge           = "too_large"
	CodeRegistrationClosed = "registration_closed"
	CodeUsernameTaken      = "username_taken"
	CodeInvalidRequest     = "invalid_request"
	CodeNotFound           = "not_found"
	CodeInsecureURL        = "insecure_url"
	CodeNetwork            = "network"
	CodeServer             = "server"
)

// Error is a failed API call.
type Error struct {
	Code    string
	Message string
	Status  int
	// RetryAfter is set for rate_limited.
	RetryAfter time.Duration
	// CurrentVersion is set for version_conflict.
	CurrentVersion int64
	// serverCode is the server's own error code, before mapping.
	serverCode string
}

func (e *Error) Error() string { return "api: " + e.Message }

// CodeOf returns the code of an *Error in err's chain, or "".
func CodeOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// maxVaultResponse bounds a downloaded vault (the server's own cap is lower).
const maxVaultResponse = 64 << 20

// NormalizeServerURL accepts HTTPS, or plain HTTP to this machine for
// development, and returns scheme://host/path without a trailing slash.
func NormalizeServerURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || u.Opaque != "" {
		return "", &Error{Code: CodeInsecureURL, Message: "not a valid URL"}
	}
	scheme, host := strings.ToLower(u.Scheme), strings.ToLower(u.Hostname())
	local := host == "localhost" || host == "127.0.0.1" || host == "::1"
	if scheme != "https" && (scheme != "http" || !local) {
		return "", &Error{Code: CodeInsecureURL, Message: "the server must use HTTPS"}
	}
	if u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", &Error{Code: CodeInsecureURL, Message: "the server URL must not contain credentials, a query or a fragment"}
	}
	return strings.TrimRight(scheme+"://"+strings.ToLower(u.Host)+u.EscapedPath(), "/"), nil
}

// Client talks to one server. The zero value is not usable; use New.
type Client struct {
	base  string
	token string
	http  *http.Client
}

// New returns a client for serverURL. hc may be nil (60 s timeout).
func New(serverURL string, hc *http.Client) (*Client, error) {
	base, err := NormalizeServerURL(serverURL)
	if err != nil {
		return nil, err
	}
	if hc == nil {
		hc = &http.Client{Timeout: 60 * time.Second}
	}
	return &Client{base: base, http: hc}, nil
}

// BaseURL is the normalized server URL.
func (c *Client) BaseURL() string { return c.base }

// SetToken sets the device token used for authenticated calls.
func (c *Client) SetToken(token string) { c.token = token }

// KDFParams are the key-derivation parameters stored for a user.
type KDFParams struct {
	KDF        string `json:"kdf"`
	Iterations int    `json:"iterations"`
}

// Session is what register and login return.
type Session struct {
	UserID      string `json:"userId"`
	DeviceID    string `json:"deviceId"`
	DeviceToken string `json:"deviceToken"`
}

// LoginSession adds the wrapped vault key and KDF parameters.
type LoginSession struct {
	Session
	KDFParams
	WrappedVaultKey []byte
}

// RegisterRequest creates an account.
type RegisterRequest struct {
	Username        string
	AuthKey         []byte
	KDF             KDFParams
	WrappedVaultKey []byte
	DeviceName      string
}

// Prelogin returns the user's KDF parameters, refusing weak ones.
func (c *Client) Prelogin(ctx context.Context, username string) (KDFParams, error) {
	var p KDFParams
	if err := c.json(ctx, http.MethodGet, "/v1/auth/prelogin?username="+url.QueryEscape(username), nil, false, &p); err != nil {
		return KDFParams{}, err
	}
	if err := crypto.CheckKDF(p.KDF, p.Iterations); err != nil {
		return KDFParams{}, err
	}
	return p, nil
}

// Register creates an account and this device.
func (c *Client) Register(ctx context.Context, req RegisterRequest) (Session, error) {
	body := map[string]any{
		"username":        req.Username,
		"authKey":         b64(req.AuthKey),
		"kdf":             req.KDF.KDF,
		"iterations":      req.KDF.Iterations,
		"wrappedVaultKey": b64(req.WrappedVaultKey),
		"deviceName":      req.DeviceName,
	}
	var s Session
	err := c.json(ctx, http.MethodPost, "/v1/auth/register", body, false, &s)
	return s, err
}

// Login signs this device in, refusing weak KDF parameters in the response.
func (c *Client) Login(ctx context.Context, username string, authKey []byte, deviceName string) (LoginSession, error) {
	var res struct {
		Session
		KDFParams
		WrappedVaultKey string `json:"wrappedVaultKey"`
	}
	body := map[string]any{"username": username, "authKey": b64(authKey), "deviceName": deviceName}
	if err := c.json(ctx, http.MethodPost, "/v1/auth/login", body, false, &res); err != nil {
		return LoginSession{}, err
	}
	if err := crypto.CheckKDF(res.KDF, res.Iterations); err != nil {
		return LoginSession{}, err
	}
	wrapped, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(res.WrappedVaultKey, "="))
	if err != nil {
		return LoginSession{}, &Error{Code: CodeServer, Message: "login response has a malformed wrappedVaultKey"}
	}
	return LoginSession{Session: res.Session, KDFParams: res.KDFParams, WrappedVaultKey: wrapped}, nil
}

// Logout revokes this device's token.
func (c *Client) Logout(ctx context.Context) error {
	resp, err := c.send(ctx, http.MethodPost, "/v1/auth/logout", nil, nil, true)
	if err == nil {
		drain(resp)
	}
	return err
}

// DeleteAccount deletes the account, its devices and every vault version.
// The server re-verifies authKey: a wrong password or SyncID is
// invalid_credentials and leaves the device signed in.
func (c *Client) DeleteAccount(ctx context.Context, authKey []byte) error {
	body, err := json.Marshal(map[string]any{"authKey": b64(authKey)})
	if err != nil {
		return err
	}
	resp, err := c.send(ctx, http.MethodPost, "/v1/account/delete", http.Header{"Content-Type": {"application/json"}}, bytes.NewReader(body), true)
	if err == nil {
		drain(resp)
	}
	return err
}

// GetStatus is the outcome of GetVault.
type GetStatus int

// GetVault outcomes.
const (
	VaultOK GetStatus = iota
	VaultNotModified
	VaultEmpty
)

// GetResult is a downloaded vault.
type GetResult struct {
	Status  GetStatus
	Version int64
	Body    []byte
}

// GetVault downloads the current vault. ifNoneMatch is the version this
// device already has (0 for none).
func (c *Client) GetVault(ctx context.Context, ifNoneMatch int64) (GetResult, error) {
	hdr := http.Header{}
	if ifNoneMatch > 0 {
		hdr.Set("If-None-Match", etag(ifNoneMatch))
	}
	resp, err := c.send(ctx, http.MethodGet, "/v1/vault", hdr, nil, true, http.StatusNotModified, http.StatusNotFound)
	if err != nil {
		return GetResult{}, err
	}
	defer drain(resp)
	switch resp.StatusCode {
	case http.StatusNotModified:
		return GetResult{Status: VaultNotModified}, nil
	case http.StatusNotFound:
		if e := toError(resp); e.serverCode == "vault_empty" {
			return GetResult{Status: VaultEmpty}, nil
		}
		return GetResult{}, &Error{Code: CodeNotFound, Message: "vault not found", Status: http.StatusNotFound}
	}
	version, ok := parseETag(resp.Header.Get("ETag"))
	if !ok {
		return GetResult{}, &Error{Code: CodeServer, Message: "vault response without a version", Status: resp.StatusCode}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxVaultResponse+1))
	if err != nil {
		return GetResult{}, &Error{Code: CodeNetwork, Message: "could not read the vault: " + err.Error()}
	}
	if len(body) > maxVaultResponse {
		return GetResult{}, &Error{Code: CodeTooLarge, Message: "vault response is too large"}
	}
	return GetResult{Status: VaultOK, Version: version, Body: body}, nil
}

// PutResult is the outcome of PutVault.
type PutResult struct {
	Version int64
	// Conflict is set on 412; CurrentVersion then holds the server's version.
	Conflict       bool
	CurrentVersion int64
}

// PutVault uploads an envelope. expected is the version merged against, or
// 0 to create the first vault (If-None-Match: *).
func (c *Client) PutVault(ctx context.Context, body []byte, expected int64) (PutResult, error) {
	hdr := http.Header{"Content-Type": {"application/octet-stream"}}
	if expected == 0 {
		hdr.Set("If-None-Match", "*")
	} else {
		hdr.Set("If-Match", etag(expected))
	}
	resp, err := c.send(ctx, http.MethodPut, "/v1/vault", hdr, bytes.NewReader(body), true)
	if err != nil {
		var e *Error
		if errors.As(err, &e) && e.Code == CodeVersionConflict {
			return PutResult{Conflict: true, CurrentVersion: e.CurrentVersion}, nil
		}
		return PutResult{}, err
	}
	defer drain(resp)
	var res struct {
		Version int64 `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return PutResult{}, &Error{Code: CodeServer, Message: "malformed upload response", Status: resp.StatusCode}
	}
	return PutResult{Version: res.Version}, nil
}

func (c *Client) json(ctx context.Context, method, path string, body any, auth bool, out any) error {
	var rdr io.Reader
	hdr := http.Header{}
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
		hdr.Set("Content-Type", "application/json")
	}
	resp, err := c.send(ctx, method, path, hdr, rdr, auth)
	if err != nil {
		return err
	}
	defer drain(resp)
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return &Error{Code: CodeServer, Message: fmt.Sprintf("malformed response to %s %s", method, path), Status: resp.StatusCode}
	}
	return nil
}

// send performs a request; non-2xx statuses other than accept become *Error.
func (c *Client) send(ctx context.Context, method, path string, hdr http.Header, body io.Reader, auth bool, accept ...int) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return nil, err
	}
	for k, v := range hdr {
		req.Header[k] = v
	}
	if auth {
		if c.token == "" {
			return nil, &Error{Code: CodeUnauthorized, Message: "this device is signed out"}
		}
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	req.Header.Set("Cache-Control", "no-store")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &Error{Code: CodeNetwork, Message: "could not reach the server: " + err.Error()}
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return resp, nil
	}
	for _, s := range accept {
		if resp.StatusCode == s {
			return resp, nil
		}
	}
	defer drain(resp)
	return nil, toError(resp)
}

// toError maps a failed response like toApiError in the extension.
func toError(resp *http.Response) *Error {
	var body struct {
		Error struct {
			Code           string `json:"code"`
			Message        string `json:"message"`
			CurrentVersion int64  `json:"currentVersion"`
		} `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&body)
	e := body.Error
	msg := e.Message
	if msg == "" {
		msg = fmt.Sprintf("server returned %d", resp.StatusCode)
	}
	out := &Error{Message: msg, Status: resp.StatusCode, serverCode: e.Code}
	switch resp.StatusCode {
	case http.StatusBadRequest:
		out.Code = CodeInvalidRequest
	case http.StatusUnauthorized:
		out.Code = CodeUnauthorized
		if e.Code == CodeInvalidCredentials {
			out.Code = CodeInvalidCredentials
		}
	case http.StatusForbidden:
		out.Code = CodeServer
		if e.Code == CodeRegistrationClosed {
			out.Code = CodeRegistrationClosed
		}
	case http.StatusNotFound:
		out.Code = CodeNotFound
	case http.StatusConflict:
		out.Code = CodeUsernameTaken
	case http.StatusPreconditionFailed:
		out.Code, out.CurrentVersion = CodeVersionConflict, e.CurrentVersion
	case http.StatusRequestEntityTooLarge:
		out.Code = CodeTooLarge
	case http.StatusTooManyRequests:
		out.Code, out.RetryAfter = CodeRateLimited, 60*time.Second
		if n, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && n > 0 {
			out.RetryAfter = time.Duration(n) * time.Second
		}
	default:
		out.Code = CodeServer
	}
	return out
}

func drain(resp *http.Response) {
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	_ = resp.Body.Close()
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func etag(v int64) string { return `"` + strconv.FormatInt(v, 10) + `"` }

func parseETag(h string) (int64, bool) {
	if len(h) < 3 || h[0] != '"' || h[len(h)-1] != '"' {
		return 0, false
	}
	s := h[1 : len(h)-1]
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, false
		}
	}
	v, err := strconv.ParseInt(s, 10, 64)
	return v, err == nil
}
