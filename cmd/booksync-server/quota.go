package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/FulgerX2007/BookSync/internal/config"
	"github.com/FulgerX2007/BookSync/internal/store"
)

const quotaUsage = `usage: booksync-server quota USERNAME [SIZE | default]

Shows a user's vault size limit, or sets it. SIZE is in bytes, or with a
binary suffix: 512K, 5M, 1G (K = 1024 bytes). "default" returns the user to
BOOKSYNC_MAX_VAULT_BYTES. Limits range from 1K to 64M, the most a client
accepts. Uses BOOKSYNC_DB_PATH like the server; it is safe while the server runs.`

// Bounds of a per-user limit: the server's own minimum, and the largest vault
// the clients download (internal/client/api's maxVaultResponse).
const (
	minVaultLimit = 1 << 10
	maxVaultLimit = 64 << 20
)

// quota implements `booksync-server quota`.
func quota(ctx context.Context, args []string, getenv func(string) string, out io.Writer) error {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		_, err := fmt.Fprintln(out, quotaUsage)
		return err
	}
	if len(args) < 1 || len(args) > 2 {
		_, _ = fmt.Fprintln(out, quotaUsage)
		return errors.New("quota: expected USERNAME [SIZE | default]")
	}
	cfg, err := config.Load(getenv)
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	username := strings.ToLower(strings.TrimSpace(args[0]))
	var limit int64 = -1
	if len(args) == 2 {
		if limit, err = parseSize(args[1]); err != nil {
			return err
		}
	}

	st, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()

	if limit >= 0 {
		err = st.SetVaultLimit(ctx, username, limit)
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("no user %q", username)
		}
		if err != nil {
			return err
		}
	}
	u, err := st.UserByUsername(ctx, username)
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no user %q", username)
	}
	if err != nil {
		return err
	}
	_, size, err := st.VaultUsage(ctx, u.ID)
	if err != nil {
		return err
	}
	effective, source := cfg.MaxVaultBytes, "server default"
	if u.MaxVaultBytes > 0 {
		effective, source = u.MaxVaultBytes, "own limit"
	}
	_, err = fmt.Fprintf(out, "%s: limit %s (%s), vault %s (%d%%)\n",
		username, sizeString(effective), source, sizeString(size), size*100/effective)
	return err
}

// parseSize reads "default" (0), bytes, or a number with a K, M or G suffix
// (binary; an optional trailing "B" or "iB" is accepted).
func parseSize(s string) (int64, error) {
	t := strings.ToUpper(strings.TrimSpace(s))
	if t == "DEFAULT" {
		return 0, nil
	}
	t = strings.TrimSuffix(strings.TrimSuffix(t, "B"), "I")
	mult := int64(1)
	switch {
	case strings.HasSuffix(t, "K"):
		mult = 1 << 10
	case strings.HasSuffix(t, "M"):
		mult = 1 << 20
	case strings.HasSuffix(t, "G"):
		mult = 1 << 30
	}
	if mult > 1 {
		t = t[:len(t)-1]
	}
	n, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64)
	if err != nil || n <= 0 || n > maxVaultLimit/mult+1 {
		return 0, fmt.Errorf("size %q: want bytes or a number with K, M or G, like 5M", s)
	}
	n *= mult
	if n < minVaultLimit || n > maxVaultLimit {
		return 0, fmt.Errorf("size %q: must be between 1K and 64M", s)
	}
	return n, nil
}

// sizeString formats bytes with a binary unit (5 MiB, 1.5 MiB, 900 B).
func sizeString(n int64) string {
	switch {
	case n >= 1<<20:
		return trimFloat(float64(n)/(1<<20)) + " MiB"
	case n >= 1<<10:
		return trimFloat(float64(n)/(1<<10)) + " KiB"
	default:
		return strconv.FormatInt(n, 10) + " B"
	}
}

func trimFloat(f float64) string {
	return strings.TrimSuffix(strconv.FormatFloat(f, 'f', 1, 64), ".0")
}
