// Package config loads the server configuration from BOOKSYNC_* environment variables.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"
)

// Config is the complete server configuration.
type Config struct {
	Addr              string
	DBPath            string
	AllowRegistration bool
	MaxVaultBytes     int64
	VaultKeepRecent   int
	VaultKeepDays     int
	TokenTTL          time.Duration
	TrustProxyHeaders bool
	LogLevel          slog.Level
}

// Default returns the configuration used when no environment variables are set.
func Default() Config {
	return Config{
		Addr:              ":8080",
		DBPath:            "/data/booksync.db",
		AllowRegistration: true,
		MaxVaultBytes:     10 << 20,
		VaultKeepRecent:   1, // history is kept per day (VaultKeepDays); see docs/protocol.md §3.3
		VaultKeepDays:     30,
		TokenTTL:          90 * 24 * time.Hour,
		TrustProxyHeaders: false,
		LogLevel:          slog.LevelInfo,
	}
}

// Load reads the configuration through getenv (os.Getenv in production) and
// validates it. All invalid values are reported together.
func Load(getenv func(string) string) (Config, error) {
	cfg := Default()
	p := parser{getenv: getenv}

	p.str("BOOKSYNC_ADDR", &cfg.Addr)
	p.str("BOOKSYNC_DB_PATH", &cfg.DBPath)
	p.boolean("BOOKSYNC_ALLOW_REGISTRATION", &cfg.AllowRegistration)
	p.int64("BOOKSYNC_MAX_VAULT_BYTES", &cfg.MaxVaultBytes)
	p.integer("BOOKSYNC_VAULT_KEEP_RECENT", &cfg.VaultKeepRecent)
	p.integer("BOOKSYNC_VAULT_KEEP_DAYS", &cfg.VaultKeepDays)
	p.duration("BOOKSYNC_TOKEN_TTL", &cfg.TokenTTL)
	p.boolean("BOOKSYNC_TRUST_PROXY_HEADERS", &cfg.TrustProxyHeaders)
	p.level("BOOKSYNC_LOG_LEVEL", &cfg.LogLevel)

	if cfg.Addr == "" {
		p.fail("BOOKSYNC_ADDR", "must not be empty")
	}
	if cfg.DBPath == "" {
		p.fail("BOOKSYNC_DB_PATH", "must not be empty")
	}
	if cfg.MaxVaultBytes < 1<<10 {
		p.fail("BOOKSYNC_MAX_VAULT_BYTES", "must be at least 1024")
	}
	if cfg.VaultKeepRecent < 1 {
		p.fail("BOOKSYNC_VAULT_KEEP_RECENT", "must be at least 1")
	}
	if cfg.VaultKeepDays < 0 {
		p.fail("BOOKSYNC_VAULT_KEEP_DAYS", "must not be negative")
	}
	if cfg.TokenTTL < time.Hour {
		p.fail("BOOKSYNC_TOKEN_TTL", "must be at least 1h")
	}

	if len(p.errs) > 0 {
		return Config{}, errors.Join(p.errs...)
	}
	return cfg, nil
}

type parser struct {
	getenv func(string) string
	errs   []error
}

func (p *parser) fail(key, msg string) {
	p.errs = append(p.errs, fmt.Errorf("%s: %s", key, msg))
}

func (p *parser) lookup(key string) (string, bool) {
	v := strings.TrimSpace(p.getenv(key))
	return v, v != ""
}

func (p *parser) str(key string, dst *string) {
	if v, ok := p.lookup(key); ok {
		*dst = v
	}
}

func (p *parser) boolean(key string, dst *bool) {
	v, ok := p.lookup(key)
	if !ok {
		return
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		p.fail(key, fmt.Sprintf("invalid boolean %q", v))
		return
	}
	*dst = b
}

func (p *parser) int64(key string, dst *int64) {
	v, ok := p.lookup(key)
	if !ok {
		return
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		p.fail(key, fmt.Sprintf("invalid integer %q", v))
		return
	}
	*dst = n
}

func (p *parser) integer(key string, dst *int) {
	v, ok := p.lookup(key)
	if !ok {
		return
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		p.fail(key, fmt.Sprintf("invalid integer %q", v))
		return
	}
	*dst = n
}

func (p *parser) duration(key string, dst *time.Duration) {
	v, ok := p.lookup(key)
	if !ok {
		return
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		p.fail(key, fmt.Sprintf("invalid duration %q", v))
		return
	}
	*dst = d
}

func (p *parser) level(key string, dst *slog.Level) {
	v, ok := p.lookup(key)
	if !ok {
		return
	}
	var l slog.Level
	if err := l.UnmarshalText([]byte(v)); err != nil {
		p.fail(key, fmt.Sprintf("invalid log level %q", v))
		return
	}
	*dst = l
}
