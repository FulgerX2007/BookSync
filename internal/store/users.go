package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// User is an account. Credentials are opaque to the store: AuthHash is the
// server-side hash of the client's authKey and WrappedVaultKey is ciphertext.
type User struct {
	ID              string
	Username        string
	AuthHash        []byte
	AuthSalt        []byte
	KDF             string
	KDFIterations   int
	WrappedVaultKey []byte
	CreatedAt       time.Time
	// MaxVaultBytes is the user's own vault size limit; 0 means the server default.
	MaxVaultBytes int64
}

// NewUser holds the fields supplied at registration.
type NewUser struct {
	Username        string
	AuthHash        []byte
	AuthSalt        []byte
	KDF             string
	KDFIterations   int
	WrappedVaultKey []byte
}

// CreateUser inserts a user. Returns ErrUsernameTaken if the username exists.
func (s *Store) CreateUser(ctx context.Context, nu NewUser) (User, error) {
	return createUser(ctx, s.db, nu, s.now())
}

func createUser(ctx context.Context, q querier, nu NewUser, now time.Time) (User, error) {
	u := User{
		ID:              newID(),
		Username:        nu.Username,
		AuthHash:        nu.AuthHash,
		AuthSalt:        nu.AuthSalt,
		KDF:             nu.KDF,
		KDFIterations:   nu.KDFIterations,
		WrappedVaultKey: nu.WrappedVaultKey,
		CreatedAt:       fromMillis(toMillis(now)),
	}
	_, err := q.ExecContext(ctx, `INSERT INTO users
		(id, username, auth_hash, auth_salt, kdf, kdf_iterations, wrapped_vault_key, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, u.Username, u.AuthHash, u.AuthSalt, u.KDF, u.KDFIterations, u.WrappedVaultKey, toMillis(now))
	if isUniqueViolation(err) {
		return User{}, ErrUsernameTaken
	}
	if err != nil {
		return User{}, fmt.Errorf("create user: %w", err)
	}
	return u, nil
}

const userColumns = `id, username, auth_hash, auth_salt, kdf, kdf_iterations, wrapped_vault_key, created_at,
	COALESCE(max_vault_bytes, 0)`

// UserByUsername looks a user up by normalized username.
func (s *Store) UserByUsername(ctx context.Context, username string) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE username = ?`, username))
}

// UserByID looks a user up by id.
func (s *Store) UserByID(ctx context.Context, id string) (User, error) {
	return userByID(ctx, s.db, id)
}

func userByID(ctx context.Context, q querier, id string) (User, error) {
	return scanUser(q.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE id = ?`, id))
}

// DeleteUser removes a user; devices and vault versions cascade.
func (s *Store) DeleteUser(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete user: %w", err)
	}
	return requireAffected(res)
}

// SetVaultLimit sets the vault size limit of the user with this normalized
// username; 0 restores the server default. Returns ErrNotFound for an unknown user.
func (s *Store) SetVaultLimit(ctx context.Context, username string, limit int64) error {
	var v any
	if limit > 0 {
		v = limit
	}
	res, err := s.db.ExecContext(ctx, `UPDATE users SET max_vault_bytes = ? WHERE username = ?`, v, username)
	if err != nil {
		return fmt.Errorf("set vault limit: %w", err)
	}
	return requireAffected(res)
}

// VaultUsage returns the user's own vault size limit (0: the server default)
// and the size of the current vault version (0 when the vault is empty).
// Returns ErrNotFound for an unknown user.
func (s *Store) VaultUsage(ctx context.Context, userID string) (limit, size int64, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT COALESCE(u.max_vault_bytes, 0),
		COALESCE((SELECT length(v.ciphertext) FROM vault_versions v WHERE v.user_id = u.id
			ORDER BY v.version DESC LIMIT 1), 0)
		FROM users u WHERE u.id = ?`, userID).Scan(&limit, &size)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, ErrNotFound
	}
	if err != nil {
		return 0, 0, fmt.Errorf("vault usage: %w", err)
	}
	return limit, size, nil
}

func scanUser(row *sql.Row) (User, error) {
	var u User
	var created int64
	err := row.Scan(&u.ID, &u.Username, &u.AuthHash, &u.AuthSalt, &u.KDF, &u.KDFIterations, &u.WrappedVaultKey, &created,
		&u.MaxVaultBytes)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("scan user: %w", err)
	}
	u.CreatedAt = fromMillis(created)
	return u, nil
}

// requireAffected maps "no rows changed" to ErrNotFound.
func requireAffected(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("rows affected: %w", err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
