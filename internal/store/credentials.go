package store

import (
	"context"
	"database/sql"
	"fmt"
)

// Credentials are the replaceable authentication fields of a user.
type Credentials struct {
	AuthHash        []byte
	AuthSalt        []byte
	KDF             string
	KDFIterations   int
	WrappedVaultKey []byte
}

// VaultRotation replaces the vault's whole history with one new version,
// encrypted under a new vault key. Expected is the version the client
// re-encrypted (0 if the vault was empty).
type VaultRotation struct {
	Expected   int64
	Ciphertext []byte
}

// ChangeCredentials atomically replaces userID's credentials and signs out
// every device except keepDeviceID. With rot set it also replaces the vault
// history with rot.Ciphertext (older versions are unreadable under the new
// key) and returns the new version; a stale rot.Expected yields a
// *VersionConflictError and changes nothing.
func (s *Store) ChangeCredentials(ctx context.Context, userID, keepDeviceID string, c Credentials, rot *VaultRotation) (int64, error) {
	var newVersion int64
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE users
			SET auth_hash = ?, auth_salt = ?, kdf = ?, kdf_iterations = ?, wrapped_vault_key = ?
			WHERE id = ?`, c.AuthHash, c.AuthSalt, c.KDF, c.KDFIterations, c.WrappedVaultKey, userID)
		if err != nil {
			return fmt.Errorf("update credentials: %w", err)
		}
		if err := requireAffected(res); err != nil {
			return err
		}

		if rot != nil {
			cur, err := currentVaultVersion(ctx, tx, userID)
			if err != nil {
				return err
			}
			if rot.Expected != cur {
				return &VersionConflictError{Current: cur}
			}
			newVersion = cur + 1
			if err := insertVault(ctx, tx, userID, keepDeviceID, newVersion, rot.Ciphertext, s.now()); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM vault_versions WHERE user_id = ? AND version < ?`, userID, newVersion); err != nil {
				return fmt.Errorf("purge vault history: %w", err)
			}
		}

		if _, err := tx.ExecContext(ctx, `DELETE FROM devices WHERE user_id = ? AND id != ?`, userID, keepDeviceID); err != nil {
			return fmt.Errorf("revoke other devices: %w", err)
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return newVersion, nil
}
