package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNormalizeUsername(t *testing.T) {
	tests := []struct {
		in   string
		want string
		ok   bool
	}{
		{"alice", "alice", true},
		{"  Alice ", "alice", true},
		{"a.b_c-9", "a.b_c-9", true},
		{"ab", "ab", false},
		{strings.Repeat("a", 64), strings.Repeat("a", 64), true},
		{strings.Repeat("a", 65), strings.Repeat("a", 65), false},
		{"has space", "has space", false},
		{"émile", "émile", false},
		{"", "", false},
	}
	for _, tt := range tests {
		got, ok := normalizeUsername(tt.in)
		if got != tt.want || ok != tt.ok {
			t.Errorf("normalizeUsername(%q) = %q, %v; want %q, %v", tt.in, got, ok, tt.want, tt.ok)
		}
	}
}

func TestNormalizeDeviceName(t *testing.T) {
	if got, err := normalizeDeviceName("  Chrome on Linux "); err != nil || got != "Chrome on Linux" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := normalizeDeviceName(strings.Repeat("é", 64)); err != nil {
		t.Fatalf("64 runes rejected: %v", err)
	}
	for _, bad := range []string{"", "   ", strings.Repeat("x", 65), "tab\there", "n\nl"} {
		if _, err := normalizeDeviceName(bad); err == nil {
			t.Errorf("normalizeDeviceName(%q) accepted", bad)
		}
	}
}

func TestValidateKDF(t *testing.T) {
	if err := validateKDF(kdfPBKDF2, minKDFIterations); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		kdf string
		n   int
	}{
		{"argon2id", minKDFIterations},
		{kdfPBKDF2, minKDFIterations - 1},
		{kdfPBKDF2, maxKDFIterations + 1},
		{"", 0},
	} {
		if err := validateKDF(tc.kdf, tc.n); err == nil {
			t.Errorf("validateKDF(%q, %d) accepted", tc.kdf, tc.n)
		}
	}
}

func TestB64JSON(t *testing.T) {
	enc, err := json.Marshal(b64{0xfb, 0xff})
	if err != nil || string(enc) != `"-_8"` {
		t.Fatalf("marshal = %s, %v", enc, err)
	}
	var b b64
	if err := json.Unmarshal([]byte(`"-_8"`), &b); err != nil || string(b) != "\xfb\xff" {
		t.Fatalf("unmarshal = %x, %v", b, err)
	}
	for _, bad := range []string{`"-_8="`, `"+/8"`, `123`, `"!!"`} {
		if err := json.Unmarshal([]byte(bad), &b); err == nil {
			t.Errorf("unmarshal(%s) accepted", bad)
		}
	}
}

func TestDecodeJSON(t *testing.T) {
	type payload struct {
		A int `json:"a"`
	}
	tests := []struct {
		name   string
		body   string
		limit  int64
		status int
	}{
		{"ok", `{"a":1}`, 100, 0},
		{"unknown field", `{"a":1,"b":2}`, 100, http.StatusBadRequest},
		{"trailing data", `{"a":1}{"a":2}`, 100, http.StatusBadRequest},
		{"malformed", `{"a":`, 100, http.StatusBadRequest},
		{"too large", `{"a":1}` + strings.Repeat(" ", 200), 100, http.StatusRequestEntityTooLarge},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tt.body))
			var p payload
			ok := decodeJSON(rec, req, &p, tt.limit)
			if tt.status == 0 {
				if !ok || p.A != 1 {
					t.Fatalf("decode failed: %d %s", rec.Code, rec.Body.String())
				}
				return
			}
			if ok || rec.Code != tt.status {
				t.Fatalf("ok=%v status=%d, want %d", ok, rec.Code, tt.status)
			}
		})
	}
}
