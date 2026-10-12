package api

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/FulgerX2007/BookSync/internal/config"
	"golang.org/x/time/rate"
)

func TestKeyedLimiterBurstAndRefill(t *testing.T) {
	now := testNow
	l := newKeyedLimiter(rate.Every(6*time.Second), 3, func() time.Time { return now })

	for i := range 3 {
		if ok, _ := l.allow("a"); !ok {
			t.Fatalf("request %d within burst rejected", i)
		}
	}
	ok, retry := l.allow("a")
	if ok || retry <= 0 || retry > 6*time.Second {
		t.Fatalf("over burst: ok=%v retry=%v", ok, retry)
	}
	if ok, _ := l.allow("b"); !ok {
		t.Fatal("independent key was limited")
	}

	now = now.Add(6 * time.Second)
	if ok, _ := l.allow("a"); !ok {
		t.Fatal("token not refilled after interval")
	}
	if ok, _ := l.allow("a"); ok {
		t.Fatal("refilled more than one token")
	}
}

func TestKeyedLimiterEvictsIdleKeys(t *testing.T) {
	now := testNow
	l := newKeyedLimiter(rate.Every(time.Second), 1, func() time.Time { return now })
	l.allow("a")
	l.allow("b")
	if l.size() != 2 {
		t.Fatalf("size = %d", l.size())
	}
	now = now.Add(limiterIdleTTL + limiterSweepEvery)
	l.allow("c")
	if l.size() != 1 {
		t.Fatalf("idle keys not evicted: size = %d", l.size())
	}
}

func TestAuthEndpointsRateLimitedPerIP(t *testing.T) {
	e := newTestEnv(t)
	for i := range authIPBurst {
		if rec := e.do(http.MethodGet, "/v1/auth/prelogin?username=x", nil); rec.Code != http.StatusOK {
			t.Fatalf("request %d: %d", i, rec.Code)
		}
	}
	rec := e.do(http.MethodPost, "/v1/auth/register", registerBody("alice", authKey(1)))
	expectError(t, rec, http.StatusTooManyRequests, codeRateLimited)
	if s, err := strconv.Atoi(rec.Header().Get("Retry-After")); err != nil || s < 1 || s > 6 {
		t.Fatalf("Retry-After = %q", rec.Header().Get("Retry-After"))
	}

	// Another client is unaffected; the first recovers after the interval.
	req := httptest.NewRequest(http.MethodGet, "/v1/auth/prelogin", nil)
	req.RemoteAddr = "198.51.100.7:4000"
	other := httptest.NewRecorder()
	e.h.ServeHTTP(other, req)
	if other.Code != http.StatusOK {
		t.Fatalf("other IP limited: %d", other.Code)
	}
	e.now = e.now.Add(6 * time.Second)
	if rec := e.do(http.MethodGet, "/v1/auth/prelogin", nil); rec.Code != http.StatusOK {
		t.Fatalf("not refilled: %d", rec.Code)
	}
}

func TestLoginRateLimitedPerIPAndUsername(t *testing.T) {
	e := newTestEnv(t)
	e.register("alice", authKey(1))
	wrong := map[string]any{"username": "alice", "authKey": authKey(2), "deviceName": "x"}
	for range loginUserIPBurst {
		expectError(t, e.do(http.MethodPost, "/v1/auth/login", wrong), http.StatusUnauthorized, codeInvalidCredentials)
	}
	// Case and whitespace do not open a new bucket.
	wrong["username"] = " ALICE"
	expectError(t, e.do(http.MethodPost, "/v1/auth/login", wrong), http.StatusTooManyRequests, codeRateLimited)
	// A different username from the same IP still has its own bucket.
	expectError(t, e.do(http.MethodPost, "/v1/auth/login",
		map[string]any{"username": "bob", "authKey": authKey(2), "deviceName": "x"}), http.StatusUnauthorized, codeInvalidCredentials)
}

func TestClientIP(t *testing.T) {
	tests := []struct {
		name    string
		trust   bool
		remote  string
		xff     []string
		wantKey string
	}{
		{"remote addr", false, "203.0.113.5:1234", nil, "203.0.113.5"},
		{"xff ignored when untrusted", false, "203.0.113.5:1234", []string{"1.2.3.4"}, "203.0.113.5"},
		{"rightmost xff when trusted", true, "172.18.0.2:1234", []string{"6.6.6.6, 1.2.3.4"}, "1.2.3.4"},
		{"last header line when trusted", true, "172.18.0.2:1234", []string{"6.6.6.6", "9.9.9.9, 1.2.3.4"}, "1.2.3.4"},
		{"trusted but no xff", true, "203.0.113.5:1234", nil, "203.0.113.5"},
		{"ipv6 grouped by /64", false, "[2001:db8:1:2:aaaa::1]:443", nil, "2001:db8:1:2::/64"},
		{"ipv4-mapped ipv6", false, "[::ffff:203.0.113.5]:443", nil, "203.0.113.5"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &Server{cfg: config.Config{TrustProxyHeaders: tt.trust}}
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.RemoteAddr = tt.remote
			for _, v := range tt.xff {
				r.Header.Add("X-Forwarded-For", v)
			}
			if got := s.clientIP(r); got != tt.wantKey {
				t.Fatalf("clientIP = %q, want %q", got, tt.wantKey)
			}
		})
	}
}

func TestSpoofedLeftmostXFFDoesNotEvadeLimit(t *testing.T) {
	e := newTestEnv(t, func(c *config.Config) { c.TrustProxyHeaders = true })
	for i := range authIPBurst + 1 {
		rec := e.do(http.MethodGet, "/v1/auth/prelogin", nil, "X-Forwarded-For", strconv.Itoa(i)+".0.0.1, 1.2.3.4")
		if i < authIPBurst && rec.Code != http.StatusOK {
			t.Fatalf("request %d: %d", i, rec.Code)
		}
		if i == authIPBurst {
			expectError(t, rec, http.StatusTooManyRequests, codeRateLimited)
		}
	}
}

func TestOversizedJSONBodyRejected(t *testing.T) {
	e := newTestEnv(t)
	body := `{"username":"` + strings.Repeat("a", maxJSONBody) + `"}`
	expectError(t, e.do(http.MethodPost, "/v1/auth/register", body), http.StatusRequestEntityTooLarge, codeRequestTooLarge)
}
