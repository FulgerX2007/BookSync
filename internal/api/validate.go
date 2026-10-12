package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	kdfPBKDF2         = "pbkdf2-sha256"
	minKDFIterations  = 600_000
	maxKDFIterations  = 10_000_000
	maxWrappedKeySize = 256
	maxDeviceNameLen  = 64
	maxJSONBody       = 64 << 10
)

const (
	codeInvalidRequest  = "invalid_request"
	codeRequestTooLarge = "request_too_large"
)

var usernameRe = regexp.MustCompile(`^[a-z0-9._-]{3,64}$`)

// normalizeUsername trims and lowercases a username and reports whether the
// result is allowed. Clients apply the same rule before deriving keys, since
// the username is part of the KDF salt.
func normalizeUsername(raw string) (string, bool) {
	u := strings.ToLower(strings.TrimSpace(raw))
	return u, usernameRe.MatchString(u)
}

// validateKDF accepts only the KDF clients implement, with at least the
// minimum cost. The upper bound only keeps values sane.
func validateKDF(kdf string, iterations int) error {
	if kdf != kdfPBKDF2 {
		return fmt.Errorf("kdf must be %q", kdfPBKDF2)
	}
	if iterations < minKDFIterations || iterations > maxKDFIterations {
		return fmt.Errorf("iterations must be between %d and %d", minKDFIterations, maxKDFIterations)
	}
	return nil
}

func validateWrappedKey(b []byte) error {
	if len(b) == 0 || len(b) > maxWrappedKeySize {
		return fmt.Errorf("wrappedVaultKey must be 1-%d bytes", maxWrappedKeySize)
	}
	return nil
}

// normalizeDeviceName trims the name and rejects empty, overlong or control-character names.
func normalizeDeviceName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || utf8.RuneCountInString(name) > maxDeviceNameLen {
		return "", fmt.Errorf("deviceName must be 1-%d characters", maxDeviceNameLen)
	}
	if strings.ContainsFunc(name, unicode.IsControl) {
		return "", errors.New("deviceName must not contain control characters")
	}
	return name, nil
}

// b64 is binary data carried in JSON as unpadded base64url.
type b64 []byte

func (b b64) MarshalJSON() ([]byte, error) {
	return json.Marshal(base64.RawURLEncoding.EncodeToString(b))
}

func (b *b64) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return errors.New("must be a base64url string")
	}
	dec, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return errors.New("must be unpadded base64url")
	}
	*b = dec
	return nil
}

// decodeJSON reads a single JSON object of at most limit bytes into dst.
// On failure it writes the error response and returns false.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any, limit int64) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	dec.DisallowUnknownFields()
	var tooLarge *http.MaxBytesError
	err := dec.Decode(dst)
	if err == nil {
		switch extra := dec.Decode(&struct{}{}); {
		case errors.Is(extra, io.EOF):
		case errors.As(extra, &tooLarge):
			err = extra
		default:
			err = errors.New("body must contain a single JSON object")
		}
	}
	if err != nil {
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, codeRequestTooLarge, "request body too large")
			return false
		}
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid JSON body: "+err.Error())
		return false
	}
	return true
}
