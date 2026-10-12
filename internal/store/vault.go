package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"time"
)

// VaultVersion is one stored encrypted snapshot. The ciphertext is opaque.
type VaultVersion struct {
	UserID     string
	Version    int64
	Ciphertext []byte // empty in listings
	DeviceID   string // empty if the writing device was deleted
	DeviceName string // listings only
	Size       int64
	CreatedAt  time.Time
}

// Retention controls which old versions survive a write: the newest
// KeepRecent versions, plus the newest version of each UTC day within the
// last KeepDays days (0 disables daily retention).
type Retention struct {
	KeepRecent int
	KeepDays   int
}

// VersionConflictError reports that the vault changed since the client read
// it. Current is the latest version (0 if the vault is empty).
type VersionConflictError struct {
	Current int64
}

func (e *VersionConflictError) Error() string {
	return fmt.Sprintf("store: vault version conflict (current %d)", e.Current)
}

// LatestVault returns the current vault, or ErrNotFound if none was uploaded yet.
func (s *Store) LatestVault(ctx context.Context, userID string) (VaultVersion, error) {
	row := s.db.QueryRowContext(ctx, `SELECT version, ciphertext, COALESCE(device_id, ''), created_at
		FROM vault_versions WHERE user_id = ? ORDER BY version DESC LIMIT 1`, userID)
	return scanVault(userID, row)
}

// VaultVersion returns one specific version of userID's vault.
func (s *Store) VaultVersion(ctx context.Context, userID string, version int64) (VaultVersion, error) {
	row := s.db.QueryRowContext(ctx, `SELECT version, ciphertext, COALESCE(device_id, ''), created_at
		FROM vault_versions WHERE user_id = ? AND version = ?`, userID, version)
	return scanVault(userID, row)
}

func scanVault(userID string, row *sql.Row) (VaultVersion, error) {
	v := VaultVersion{UserID: userID}
	var created int64
	err := row.Scan(&v.Version, &v.Ciphertext, &v.DeviceID, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return VaultVersion{}, ErrNotFound
	}
	if err != nil {
		return VaultVersion{}, fmt.Errorf("scan vault: %w", err)
	}
	v.Size = int64(len(v.Ciphertext))
	v.CreatedAt = fromMillis(created)
	return v, nil
}

// PutVault stores a new version if the current version equals expected
// (nil means "the vault must still be empty"); otherwise it returns a
// *VersionConflictError. Old versions are pruned per ret. Runs in one
// immediate transaction, so concurrent writers serialize.
func (s *Store) PutVault(ctx context.Context, userID, deviceID string, expected *int64, ciphertext []byte, ret Retention) (int64, error) {
	var next int64
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		cur, err := currentVaultVersion(ctx, tx, userID)
		if err != nil {
			return err
		}
		if (expected == nil && cur != 0) || (expected != nil && *expected != cur) {
			return &VersionConflictError{Current: cur}
		}
		next = cur + 1
		now := s.now()
		if err := insertVault(ctx, tx, userID, deviceID, next, ciphertext, now); err != nil {
			return err
		}
		return pruneVault(ctx, tx, userID, ret, now)
	})
	if err != nil {
		return 0, err
	}
	return next, nil
}

func currentVaultVersion(ctx context.Context, q querier, userID string) (int64, error) {
	var cur int64
	if err := q.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM vault_versions WHERE user_id = ?`, userID).Scan(&cur); err != nil {
		return 0, fmt.Errorf("current vault version: %w", err)
	}
	return cur, nil
}

func insertVault(ctx context.Context, q querier, userID, deviceID string, version int64, ciphertext []byte, now time.Time) error {
	var dev any
	if deviceID != "" {
		dev = deviceID
	}
	_, err := q.ExecContext(ctx, `INSERT INTO vault_versions (user_id, version, ciphertext, device_id, created_at)
		VALUES (?, ?, ?, ?, ?)`, userID, version, ciphertext, dev, toMillis(now))
	if err != nil {
		return fmt.Errorf("insert vault: %w", err)
	}
	return nil
}

const dayMillis = 24 * 60 * 60 * 1000

// pruneVault deletes versions that are neither among the newest KeepRecent
// nor the newest of their UTC day within the daily-retention window.
func pruneVault(ctx context.Context, q querier, userID string, ret Retention, now time.Time) error {
	cutoff := int64(math.MaxInt64)
	if ret.KeepDays > 0 {
		y, m, d := now.UTC().Date()
		cutoff = toMillis(time.Date(y, m, d, 0, 0, 0, 0, time.UTC).AddDate(0, 0, -ret.KeepDays))
	}
	_, err := q.ExecContext(ctx, `DELETE FROM vault_versions
		WHERE user_id = ?1
		  AND version NOT IN (
		    SELECT version FROM vault_versions WHERE user_id = ?1 ORDER BY version DESC LIMIT ?2)
		  AND version NOT IN (
		    SELECT MAX(version) FROM vault_versions
		    WHERE user_id = ?1 AND created_at >= ?3
		    GROUP BY created_at / ?4)`,
		userID, ret.KeepRecent, cutoff, dayMillis)
	if err != nil {
		return fmt.Errorf("prune vault: %w", err)
	}
	return nil
}

// ListVaultVersions returns metadata of the stored versions, newest first.
func (s *Store) ListVaultVersions(ctx context.Context, userID string) ([]VaultVersion, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT v.version, COALESCE(v.device_id, ''), COALESCE(d.name, ''),
			length(v.ciphertext), v.created_at
		FROM vault_versions v LEFT JOIN devices d ON d.id = v.device_id
		WHERE v.user_id = ? ORDER BY v.version DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("list vault versions: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []VaultVersion
	for rows.Next() {
		v := VaultVersion{UserID: userID}
		var created int64
		if err := rows.Scan(&v.Version, &v.DeviceID, &v.DeviceName, &v.Size, &created); err != nil {
			return nil, fmt.Errorf("scan vault version: %w", err)
		}
		v.CreatedAt = fromMillis(created)
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list vault versions: %w", err)
	}
	return out, nil
}
