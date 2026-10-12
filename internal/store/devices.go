package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Device is a signed-in browser. Only the hash of its bearer token is stored.
type Device struct {
	ID         string
	UserID     string
	Name       string
	TokenHash  []byte
	CreatedAt  time.Time
	LastSeenAt time.Time
	ExpiresAt  time.Time
}

// NewDevice holds the fields supplied when a device signs in.
type NewDevice struct {
	Name      string
	TokenHash []byte
	TTL       time.Duration
}

// Register creates a user and its first device atomically.
func (s *Store) Register(ctx context.Context, nu NewUser, nd NewDevice) (User, Device, error) {
	var u User
	var d Device
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		now := s.now()
		var err error
		if u, err = createUser(ctx, tx, nu, now); err != nil {
			return err
		}
		d, err = createDevice(ctx, tx, u.ID, nd, now)
		return err
	})
	if err != nil {
		return User{}, Device{}, err
	}
	return u, d, nil
}

// CreateDevice adds a device for an existing user.
func (s *Store) CreateDevice(ctx context.Context, userID string, nd NewDevice) (Device, error) {
	return createDevice(ctx, s.db, userID, nd, s.now())
}

func createDevice(ctx context.Context, q querier, userID string, nd NewDevice, now time.Time) (Device, error) {
	d := Device{
		ID:         newID(),
		UserID:     userID,
		Name:       nd.Name,
		TokenHash:  nd.TokenHash,
		CreatedAt:  fromMillis(toMillis(now)),
		LastSeenAt: fromMillis(toMillis(now)),
		ExpiresAt:  fromMillis(toMillis(now.Add(nd.TTL))),
	}
	_, err := q.ExecContext(ctx, `INSERT INTO devices
		(id, user_id, name, token_hash, created_at, last_seen_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		d.ID, d.UserID, d.Name, d.TokenHash, toMillis(d.CreatedAt), toMillis(d.LastSeenAt), toMillis(d.ExpiresAt))
	if err != nil {
		return Device{}, fmt.Errorf("create device: %w", err)
	}
	return d, nil
}

const deviceColumns = `id, user_id, name, token_hash, created_at, last_seen_at, expires_at`

// DeviceByTokenHash finds the device owning a token. Expiry is not checked here.
func (s *Store) DeviceByTokenHash(ctx context.Context, tokenHash []byte) (Device, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+deviceColumns+` FROM devices WHERE token_hash = ?`, tokenHash)
	var d Device
	err := scanDevice(row.Scan, &d)
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, ErrNotFound
	}
	return d, err
}

// TouchDevice records activity and slides the expiry forward.
func (s *Store) TouchDevice(ctx context.Context, id string, ttl time.Duration) error {
	now := s.now()
	res, err := s.db.ExecContext(ctx, `UPDATE devices SET last_seen_at = ?, expires_at = ? WHERE id = ?`,
		toMillis(now), toMillis(now.Add(ttl)), id)
	if err != nil {
		return fmt.Errorf("touch device: %w", err)
	}
	return requireAffected(res)
}

// ListDevices returns a user's devices, oldest first.
func (s *Store) ListDevices(ctx context.Context, userID string) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+deviceColumns+` FROM devices WHERE user_id = ? ORDER BY created_at, id`, userID)
	if err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Device
	for rows.Next() {
		var d Device
		if err := scanDevice(rows.Scan, &d); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}
	return out, nil
}

// DeleteDevice removes one of userID's devices. Another user's device id
// yields ErrNotFound.
func (s *Store) DeleteDevice(ctx context.Context, userID, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM devices WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return fmt.Errorf("delete device: %w", err)
	}
	return requireAffected(res)
}

func scanDevice(scan func(dest ...any) error, d *Device) error {
	var created, seen, expires int64
	if err := scan(&d.ID, &d.UserID, &d.Name, &d.TokenHash, &created, &seen, &expires); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return err
		}
		return fmt.Errorf("scan device: %w", err)
	}
	d.CreatedAt, d.LastSeenAt, d.ExpiresAt = fromMillis(created), fromMillis(seen), fromMillis(expires)
	return nil
}
