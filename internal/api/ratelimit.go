package api

import (
	"math"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

const codeRateLimited = "rate_limited"

// Limits on unauthenticated auth endpoints. Online guessing is already
// infeasible (authKey depends on the 128-bit SyncID), so these exist to stop
// abuse such as registration spam, not to protect passwords. There is
// deliberately no global per-username limit: it would let anyone lock a user
// out of signing in on new devices.
var (
	authIPRate        = rate.Every(6 * time.Second) // 10/min per client IP
	authIPBurst       = 10
	loginUserIPRate   = rate.Every(12 * time.Second) // 5/min per (IP, username)
	loginUserIPBurst  = 5
	limiterIdleTTL    = 10 * time.Minute
	limiterSweepEvery = time.Minute
)

// keyedLimiter is a set of token buckets keyed by string, with idle-entry eviction.
type keyedLimiter struct {
	mu        sync.Mutex
	rate      rate.Limit
	burst     int
	now       func() time.Time
	entries   map[string]*limiterEntry
	lastSweep time.Time
}

type limiterEntry struct {
	lim      *rate.Limiter
	lastSeen time.Time
}

func newKeyedLimiter(r rate.Limit, burst int, now func() time.Time) *keyedLimiter {
	return &keyedLimiter{rate: r, burst: burst, now: now, entries: map[string]*limiterEntry{}}
}

// allow takes a token for key. When none is available it reports how long
// until one will be.
func (l *keyedLimiter) allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.sweep(now)
	e, ok := l.entries[key]
	if !ok {
		e = &limiterEntry{lim: rate.NewLimiter(l.rate, l.burst)}
		l.entries[key] = e
	}
	e.lastSeen = now
	res := e.lim.ReserveN(now, 1)
	if delay := res.DelayFrom(now); delay > 0 {
		res.CancelAt(now)
		return false, delay
	}
	return true, 0
}

// sweep drops entries idle long enough that their bucket is full again.
func (l *keyedLimiter) sweep(now time.Time) {
	if now.Sub(l.lastSweep) < limiterSweepEvery {
		return
	}
	l.lastSweep = now
	for k, e := range l.entries {
		if now.Sub(e.lastSeen) > limiterIdleTTL {
			delete(l.entries, k)
		}
	}
}

func (l *keyedLimiter) size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.entries)
}

// limitByIP wraps an auth handler with the per-IP limiter.
func (s *Server) limitByIP(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.allowed(w, s.authIPLimiter, s.clientIP(r)) {
			return
		}
		next(w, r)
	}
}

// allowed applies limiter to key and writes the 429 response when exhausted.
func (s *Server) allowed(w http.ResponseWriter, l *keyedLimiter, key string) bool {
	ok, retryAfter := l.allow(key)
	if ok {
		return true
	}
	w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(retryAfter.Seconds()))))
	writeError(w, http.StatusTooManyRequests, codeRateLimited, "too many requests; retry later")
	return false
}

// clientIP returns the rate-limit key for the request's client. Behind a
// trusted reverse proxy it uses the rightmost X-Forwarded-For entry: the
// address the proxy itself saw. Entries further left are client-supplied and
// can be forged. IPv6 clients are grouped by /64, the usual end-site prefix.
func (s *Server) clientIP(r *http.Request) string {
	raw := ""
	if s.cfg.TrustProxyHeaders {
		if values := r.Header.Values("X-Forwarded-For"); len(values) > 0 {
			parts := strings.Split(values[len(values)-1], ",")
			raw = strings.TrimSpace(parts[len(parts)-1])
		}
	}
	if raw == "" {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		raw = host
	}
	addr, err := netip.ParseAddr(raw)
	if err != nil {
		return raw
	}
	addr = addr.Unmap()
	if addr.Is6() {
		if p, err := addr.Prefix(64); err == nil {
			return p.String()
		}
	}
	return addr.String()
}
