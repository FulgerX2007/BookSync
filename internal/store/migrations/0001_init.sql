CREATE TABLE users (
  id                TEXT PRIMARY KEY,           -- random 128-bit, base64url
  username          TEXT NOT NULL UNIQUE,       -- normalized
  auth_hash         BLOB NOT NULL,              -- Argon2id(authKey)
  auth_salt         BLOB NOT NULL,
  kdf               TEXT NOT NULL,              -- 'pbkdf2-sha256'
  kdf_iterations    INTEGER NOT NULL,
  wrapped_vault_key BLOB NOT NULL,
  created_at        INTEGER NOT NULL            -- unix ms
);

CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   BLOB NOT NULL UNIQUE,            -- SHA-256(token)
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL                 -- sliding, refreshed at most hourly
);
CREATE INDEX devices_user_id ON devices(user_id);

CREATE TABLE vault_versions (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  ciphertext BLOB NOT NULL,
  device_id  TEXT REFERENCES devices(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, version)
);
CREATE INDEX vault_versions_device_id ON vault_versions(device_id);
