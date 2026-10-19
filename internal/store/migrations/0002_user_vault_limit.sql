-- A per-user vault size limit. NULL means the server default
-- (BOOKSYNC_MAX_VAULT_BYTES).
ALTER TABLE users ADD COLUMN max_vault_bytes INTEGER;
