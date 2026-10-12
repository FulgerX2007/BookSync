# BookSync: E2E-encrypted cross-browser bookmark sync

## Overview
- BookSync keeps bookmarks in two-way sync across every browser a person uses through a self-hosted Go server. v1 covers the Chromium family (Chrome, Edge, Brave, Vivaldi, Opera) and Firefox.
- **Problem:** native browser sync only works inside one vendor's ecosystem. People who use several browsers end up with divergent bookmark sets, and the native options store bookmarks with a third party.
- **Key properties:**
  - **Two-way, near-live sync.** Local changes reach the server within ~5 s (debounced). Other browsers pick them up within ~1 min (polling with ETag/304).
  - **End-to-end encrypted.** The server stores only ciphertext and cannot read titles, URLs or folder structure, or even count bookmarks.
  - **Multi-user, self-hosted.** One CGO-free Go binary in a distroless container with SQLite storage, plus Caddy for automatic TLS.
  - **Login model.** Registration generates a **SyncID**, a client-side 128-bit secret. Signing in on another browser needs **username + password + SyncID**.
- **Integration:** this is a greenfield project; the repository is empty. The plan establishes the Go server layout (`cmd/`, `internal/`, `deploy/`) and the TypeScript WebExtension (`extension/`).

### Acceptance criteria
1. A user registers from the extension in browser A and receives a SyncID plus a downloadable emergency kit.
2. The user signs in from browser B, from a different family (e.g. Chrome → Firefox), with username + password + SyncID. Existing bookmarks on both sides merge without duplicates.
3. Create, rename, move and delete in any signed-in browser propagate to all others. The change reaches the server within ~5 s, and other browsers within ~1 min.
4. Concurrent edits on several browsers converge to identical trees on every device.
5. The server database contains no plaintext titles or URLs. A wrong SyncID or password cannot sign in. The server operator cannot decrypt vaults.
6. A sync that would delete a large share of bookmarks pauses for user confirmation. Any of the last N server-side versions can be restored.
7. Users can list and revoke devices. A password change re-wraps the vault key and signs out the other devices. Account deletion removes all server data.
8. `docker compose up` with `deploy/docker-compose.yml` runs a working HTTPS server.

### Non-goals for v1
- Safari, mobile browsers, a Go CLI client.
- Firefox separators, tags and keywords; favicons; Chromium managed (policy) bookmarks; exact `dateAdded` fidelity.
- Sharing folders between users, admin UI, password or SyncID recovery (impossible by design under E2EE).
- A push channel (SSE/WebSocket), PostgreSQL, an Argon2id client KDF. All are listed under Post-Completion as follow-ups.

## Context (from discovery)
- **Repository:** empty, no commits. Branch `claude/epic-ride-n5y2t8`; remote `github.com/FulgerX2007/BookSync`.
- **Toolchains available:** Go 1.24.7; Node 22 / npm 10; Chromium preinstalled for Playwright (`/opt/pw-browsers`).
- **Existing patterns:** none yet. Conventions this plan establishes:
  - Go: standard `cmd/` + `internal/` layout, stdlib `net/http` with Go 1.22+ pattern routing, `log/slog`, table-driven tests with stdlib `testing` + `net/http/httptest`, real SQLite in `t.TempDir()` instead of store mocks.
  - Extension: TypeScript (strict), Manifest V3, one codebase built twice (Chromium and Firefox), vitest + fast-check, Playwright for e2e.
- **Dependencies identified:**
  - Go: `modernc.org/sqlite` (CGO-free), `golang.org/x/crypto/argon2`, `golang.org/x/time/rate`.
  - Extension runtime: `webextension-polyfill`.
  - Extension dev: `typescript`, `esbuild`, `vitest`, `fast-check`, `fake-indexeddb`, `@playwright/test`, `eslint` + `typescript-eslint`, `web-ext`, `@types/webextension-polyfill`.

## Development Approach
- **testing approach**: Regular (code first, then tests in the same task)
- complete each task fully before moving to the next
- make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
  - tests are not optional - they are a required part of the checklist
  - write unit tests for new functions/methods
  - write unit tests for modified functions/methods
  - add new test cases for new code paths
  - update existing test cases if behavior changes
  - tests cover both success and error scenarios
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- run tests after each change
- maintain backward compatibility. The vault `format` and the client KDF parameters are versioned from day one so later changes can migrate.

## Testing Strategy
- **Unit tests (Go):** `go test -race ./...`.
  - Handlers are tested through `httptest` against a real SQLite DB in `t.TempDir()`.
  - Concurrency-sensitive code (vault versioning) gets parallel-goroutine tests under `-race`.
- **Unit tests (extension):** `cd extension && npm test` (vitest), using these fakes:
  - an in-memory `bookmarks` API with Chromium **or** Firefox semantics (`test/fakes/bookmarks.ts`);
  - an in-memory server implementing `ApiClient` (`test/fakes/server.ts`);
  - `fake-indexeddb` for local state.
- **Property-based tests (fast-check)** cover the highest-risk code: the 3-way merge invariants, and multi-device convergence (2–3 simulated browsers of mixed flavors syncing random edits against one fake server).
- **E2E tests (Playwright):** `cd extension && npm run e2e`.
  - Chromium persistent contexts load the unpacked e2e build of the extension and talk to the real Go server binary, which runs on a free port with a temp DB.
  - Two profiles simulate two browsers.
  - Use `channel: 'chromium'` (new headless) so extensions load in headless mode.
  - UI tasks add their e2e specs in the same task.
- **Firefox:** covered by adapter and engine unit tests against the Firefox-flavored fake. Playwright cannot load Firefox extensions, so a real-Firefox run is a manual check under Post-Completion.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope
- keep plan in sync with actual work done

## Solution Overview

```
 ┌────────── Browser A (Chrome/Edge/Brave…) ──────────┐   ┌──────────── Browser B (Firefox) ────────────┐
 │ bookmarks API ⇄ adapter ⇄ projection / applier      │   │ bookmarks API ⇄ adapter ⇄ projection / applier│
 │ sync engine: 3-way merge (base, local, remote)      │   │ sync engine: 3-way merge                      │
 │ crypto: PBKDF2→HKDF keys, AES-256-GCM vault         │   │ crypto (same code)                            │
 │ state: IndexedDB (session, vault key, base, idMap)  │   │ state: IndexedDB                              │
 └───────────────────────┬─────────────────────────────┘   └──────────────────────┬───────────────────────┘
                         │  HTTPS: auth JSON + opaque encrypted vault (ETag / If-Match)  │
                         ▼                                                               ▼
              ┌──────────────────────────── booksync-server (Go) ─────────────────────────────┐
              │ auth: Argon2id(authKey) · device tokens · rate limits · vault versions        │
              │ SQLite: users · devices · vault_versions (ciphertext only, last N kept)       │
              └───────────────────────────────────────────────────────────────────────────────┘
                                   ▲ Caddy (automatic HTTPS) in docker-compose
```

**Key design decisions**
1. **Encrypted whole-tree snapshot with optimistic locking.** Chosen over a per-record store or an operation log.
   - Each user has one encrypted vault blob with a server version number. Clients upload with `If-Match`; a stale version gets `412`, and the client re-merges.
   - The server stays trivial, the tree is always consistent, and the server learns almost nothing.
   - History and restore come free: the server keeps the last N blobs.
   - Cost: every change uploads the whole tree. That is about 200–300 KB gzipped for 5k bookmarks, which is acceptable with debouncing.
2. **All merging happens in the client.** E2EE forces this. The merge rules are deterministic, so every device computes the same result; the server is versioned dumb storage.
3. **The SyncID is a client-side secret mixed into key derivation** (two-secret key derivation, as with 1Password's Secret Key).
   - It never reaches the server, so a stolen server database cannot be cracked offline: an attacker would need the password **and** 128 random bits.
   - Losing the SyncID means losing the account. It is shown once at registration as an emergency kit, and stays viewable on signed-in devices.
4. **A random vault key is wrapped by a password-derived KEK.** A password change only re-wraps the key; the vault is never re-encrypted.
5. **Crash-safe ordering.** Merge, apply locally, upload, then advance `base` only after both sides succeed. A partial failure just re-merges on the next run, because the merge is idempotent.
6. **Polling instead of push for remote changes.** `alarms` fire every 1 min and send `GET /v1/vault` with `If-None-Match`, which is cheap thanks to 304s. MV3 service workers cannot hold sockets reliably, so the push channel is deferred.
7. **Conflict policy: edit beats delete. On a true conflict, the version already on the server wins** (first-committed wins). The policy is simple, deterministic and convergent.
8. **Stack: TypeScript in the extension, Go on the server.** The extension uses native WebCrypto, with no WASM in MV3 service workers. SQLite through `modernc.org/sqlite` keeps the server a single static binary.

## Technical Details

### Cryptography (client-side, WebCrypto)
```
u         = normalizeUsername(username)        // trim + lowercase, must match [a-z0-9._-]{3,64}
sid       = 16 random bytes = SyncID           // generated at registration, NEVER sent to the server
stretched = PBKDF2-HMAC-SHA256(utf8(password), salt = SHA-256("booksync/v1|" + u), iterations = 600000, 32 B)
authKey   = HKDF-SHA256(ikm = stretched, salt = sid, info = "booksync/v1/auth", 32 B)   → sent to the server
kek       = HKDF-SHA256(ikm = stretched, salt = sid, info = "booksync/v1/kek",  32 B)   → AES-256-GCM key, stays on the client
vaultKey  = 32 random bytes, generated once at registration (AES-256-GCM)
wrapped   = iv(12) ‖ AES-GCM(kek, iv, aad = "booksync/v1/wrap|" + u, vaultKey)        → stored on the server
vault     = "BSV1" ‖ iv(12) ‖ AES-GCM(vaultKey, iv, aad = "booksync/v1/vault|" + u, gzip(JSON(VaultDoc)))
server    : stores Argon2id(authKey, salt = random 16 B, m = 19 MiB, t = 2, p = 1); compares in constant time
```
- **SyncID display format:** `BS1-` + Crockford base32 of the 16 bytes (26 chars) + 1 check char, grouped for readability.
  - The parser tolerates case, spaces and dashes, and maps I/L→1 and O→0.
  - The check char catches typos before a wasted login round-trip.
- **Why PBKDF2 and not Argon2id on the client:** PBKDF2 is WebCrypto-native with no WASM, and the SyncID's 128 bits already make offline attacks infeasible. The KDF name and iteration count are stored per user, so moving to Argon2id later is a migration, not a redesign.
- **Nonces:** a random 96-bit IV for every encryption. Uploads per user stay far below the 2³² safety bound.
- **AAD:** binds every ciphertext to its purpose and its user, so the server cannot swap blobs between users or between purposes.

### Vault document (plaintext before gzip + encryption)
```ts
type Guid = string; // 12-char base64url; roots use fixed Firefox GUIDs below
interface VNode {
  guid: Guid;
  kind: 'folder' | 'bookmark';
  title: string;
  url?: string;        // bookmarks only
  children?: Guid[];   // folders only, ordered
  dateAdded?: number;  // informational only; ignored by comparisons and merge
}
interface VaultDoc {
  format: 1;           // unknown higher format → "update the extension" error, never overwrite
  seq: number;         // +1 per upload, inside the ciphertext → rollback detection
  writtenBy: string;   // deviceId
  writtenAt: number;   // ms epoch
  nodes: Record<Guid, VNode>; // includes the 4 roots
}
```

| Canonical root GUID | Firefox | Chromium family |
|---|---|---|
| `toolbar_____` | Bookmarks Toolbar | Bookmarks bar (`folderType: "bookmarks-bar"`, legacy id `1`) |
| `unfiled_____` | Other Bookmarks | Other bookmarks (`"other"`, legacy id `2`) |
| `mobile______` | Mobile Bookmarks | Mobile bookmarks (`"mobile"`, legacy id `3`) |
| `menu________` | Bookmarks Menu | folder "Bookmarks Menu" inside Other bookmarks, created on demand |

- **Chromium 134+ account storage** can expose two permanent folders per `folderType` (a local one and a Google-account one).
  - Prefer the node with `syncing !== true`.
  - If only a syncing node exists, use it and show a "native browser sync is on" warning, since running both syncs causes duplicates.
- **Firefox separators** are filtered out on read. When writing, sync indices are translated to native indices around the separators.
- **"Skipped" nodes:** bookmarks that a browser refuses to create (e.g. Firefox rejects privileged URL schemes such as `javascript:` or `chrome:`).
  - Their GUIDs are recorded in a `skipped` set.
  - The projection re-inserts them from `base`, so they never look like local deletions.

### Server API
Binary fields in JSON (`authKey`, `wrappedVaultKey`) use base64url without padding. Errors look like `{"error":{"code":"…","message":"…"}}`. Device auth uses `Authorization: Bearer bst_<base64url 32 B>`.

| Method & path | Auth | Request | Responses |
|---|---|---|---|
| `GET /healthz` | – | – | 200 |
| `GET /v1/auth/prelogin?username=` | – | – | 200 `{kdf, iterations}` (identical defaults for unknown users) |
| `POST /v1/auth/register` | – | `{username, authKey, kdf, iterations, wrappedVaultKey, deviceName}` | 201 `{userId, deviceId, deviceToken}` · 400 · 403 `registration_closed` · 409 `username_taken` |
| `POST /v1/auth/login` | – | `{username, authKey, deviceName}` | 200 `{userId, deviceId, deviceToken, wrappedVaultKey, kdf, iterations}` · 401 `invalid_credentials` |
| `POST /v1/auth/logout` | device | – | 204 |
| `GET /v1/devices` | device | – | 200 `[{id, name, createdAt, lastSeenAt, current}]` |
| `DELETE /v1/devices/{id}` | device | – | 204 · 404 |
| `POST /v1/account/password` | device | `{currentAuthKey, newAuthKey, iterations, newWrappedVaultKey}` | 204 (other devices revoked) · 401 |
| `POST /v1/account/delete` | device | `{authKey}` | 204 · 401 |
| `GET /v1/vault` | device | `If-None-Match: "<v>"` (optional) | 200 `application/octet-stream` + `ETag: "<v>"` · 304 · 404 `vault_empty` |
| `PUT /v1/vault` | device | octet-stream; `If-Match: "<v>"` or `If-None-Match: *` | 200 `{version}` + ETag · 400 `invalid_vault` · 412 `version_conflict {currentVersion}` · 413 · 428 |
| `GET /v1/vault/versions` | device | – | 200 `[{version, createdAt, deviceName, size}]` |
| `GET /v1/vault/versions/{version}` | device | – | 200 octet-stream · 404 |
| any `/v1/auth/*` | – | – | 429 `rate_limited` + `Retry-After` |

### Database schema (SQLite, `internal/store/migrations/0001_init.sql`)
```sql
CREATE TABLE users (
  id                TEXT PRIMARY KEY,           -- random 128-bit, base64url
  username          TEXT NOT NULL UNIQUE,       -- normalized
  auth_hash         BLOB NOT NULL,              -- Argon2id(authKey)
  auth_salt         BLOB NOT NULL,
  kdf               TEXT NOT NULL,              -- 'pbkdf2-sha256'
  kdf_iterations    INTEGER NOT NULL,
  wrapped_vault_key BLOB NOT NULL,
  created_at        INTEGER NOT NULL
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
CREATE TABLE vault_versions (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  ciphertext BLOB NOT NULL,
  device_id  TEXT REFERENCES devices(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, version)
);
```
- The current vault is the row with `MAX(version)` for the user.
- `PutVault` runs as a single `BEGIN IMMEDIATE` transaction (DSN `_txlock=immediate`): compare the version, insert `version+1`, prune to N. SQLite's single writer makes this race-free.
- The connection uses WAL, `foreign_keys=ON` and `busy_timeout=5000`.

### Server configuration (env)
| Variable | Default | Purpose |
|---|---|---|
| `BOOKSYNC_ADDR` | `:8080` | listen address |
| `BOOKSYNC_DB_PATH` | `/data/booksync.db` | SQLite file |
| `BOOKSYNC_ALLOW_REGISTRATION` | `true` | open/close sign-ups |
| `BOOKSYNC_MAX_VAULT_BYTES` | `10485760` | max encrypted vault size |
| `BOOKSYNC_VAULT_HISTORY` | `20` | vault versions kept per user |
| `BOOKSYNC_TOKEN_TTL` | `2160h` | sliding device-token expiry (90 days) |
| `BOOKSYNC_TRUST_PROXY_HEADERS` | `false` | take the client IP from `X-Forwarded-For` (behind Caddy) |
| `BOOKSYNC_LOG_LEVEL` | `info` | slog level |

### Sync algorithm (`syncOnce`, runs single-flight in the background)
1. Load state. Project the browser tree into a `VaultDoc` (`local`) using `idMap`, and re-insert `skipped` nodes from `base`.
2. Send `GET /v1/vault` with `If-None-Match: version`.
   - 304: `remote = base`.
   - 404: `remote = null`.
   - 200: decrypt into `remote`.
3. **Rollback check.** If `remote.seq < lastSeq`, or `remote == null` while `base != null`, return `rollback_detected` and stop.
4. **Merge.**
   - No `base` (fresh device): `firstSync(local, remote)`, which bootstraps or joins with dedupe.
   - Otherwise: `merge3(base, local, remote ?? empty)`.
5. **Guard.** If the deletions in either direction exceed 25 % of nodes **and** number at least 20, return `needs_confirmation` unless the call is `confirmed`.
6. If `merged ≠ local`: diff and apply the ops to the browser, updating `idMap` and `skipped`. On failure, abort without advancing `base`.
7. If `merged ≠ remote`: set `merged.seq = max(remote.seq, lastSeq) + 1`, encrypt, then `PUT` with `If-Match` (or `If-None-Match: *`).
   - On 412, go back to step 1, at most 3 times; then return `conflict_exhausted` and let the scheduler back off.
8. Persist `base = merged`, `version` and `lastSeq`. Status becomes `ok`.

### Merge rules (`merge3(base, local, remote)`, per GUID)
| Situation | Result |
|---|---|
| unchanged on both sides | keep |
| changed on one side only (title, url, parent, child order) | take that side |
| identical change on both sides | take it |
| `title`/`url` changed differently on both | remote wins (first-committed wins) |
| parent changed differently on both | remote wins |
| added on one side | add |
| deleted on one side, unchanged on the other | delete |
| deleted on one side, edited or moved on the other | keep the edited node (edit beats delete) |
| folder deleted on one side, descendants added or edited on the other | folder stays deleted; surviving descendants move to the nearest surviving ancestor (Firefox Dogear rule), falling back to `unfiled_____` |
| deleted on both | delete |
| child order: only one side reordered | that side's order; the other side's new children are inserted after their predecessor |
| child order: both reordered | remote order; local-only new children inserted after their local predecessor, else appended |
| merge produces a cycle | use the remote parent for nodes in the cycle; if still cyclic, move them to `unfiled_____` |
| roots | never added, deleted, moved or renamed (titles are localized per browser) |

**First sync** (`firstSync`, for a device without `base`):
- The device's nodes are matched top-down against the remote tree:
  - folders by title within their matched parent;
  - bookmarks by normalized URL, with the title as tie-breaker;
  - each remote node is matched at most once.
- The result is the remote tree plus the unmatched local nodes. Nothing is ever deleted or renamed on the remote side.
- A joining device adopts the account's titles and ordering for matched items and keeps its own extras.

### Local extension state (IndexedDB `booksync`)
- `session`: serverUrl, username, userId, deviceId, deviceToken, syncId, kdf iterations.
- `vaultKey`: a non-extractable `CryptoKey`, stored by structured clone.
- `sync`: `base` (last synced `VaultDoc`), `version` (server ETag), `lastSeq`, `skipped` GUIDs, `status`, `pendingConfirmation` summary.
- `idmap`: browser-local id ↔ GUID, in both directions.

### Security model
| The server learns | The server cannot learn |
|---|---|
| usernames, device names, client IPs, sync timestamps, vault size and number of versions | titles, URLs, folder structure, bookmark count, password, SyncID, vault key |

- **Stolen server DB:** offline guessing needs both the password and the 128-bit SyncID, which is infeasible.
- **Malicious or compromised server:**
  - It cannot read or forge vault contents (AEAD).
  - Replaying an old vault is detected by the encrypted `seq` (`rollback_detected`).
  - It can still deny service.
  - It does not serve the client code; the extension is installed from the stores, which is an advantage over web-based E2EE.
- **Online guessing:** prevented by per-IP and per-username rate limits, Argon2id cost, the generic `invalid_credentials` error, and a dummy hash for unknown users.
- **Username enumeration** through a registration `409` is accepted for self-hosted deployments.
- **Out of scope:**
  - A compromised device. Mitigation: revoke it from the devices list and change the password.
  - Malicious extension updates. Mitigation: minimal dependencies.

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): tasks achievable within this codebase - code changes, tests, documentation updates
- **Post-Completion** (no checkboxes): items requiring external action - manual testing, changes in consuming projects, deployment configs, third-party verifications

## Implementation Steps

### Task 1: Scaffold the Go server module, config and health endpoint

**Files:**
- Create: `go.mod`
- Create: `cmd/booksync-server/main.go`
- Create: `internal/config/config.go`
- Create: `internal/config/config_test.go`
- Create: `internal/api/server.go`
- Create: `internal/api/respond.go`
- Create: `internal/api/server_test.go`
- Create: `Makefile`
- Create: `.golangci.yml`
- Create: `.gitignore`

- [ ] init module `github.com/FulgerX2007/BookSync` (`go 1.24`); add `Makefile` targets `build`, `run`, `test`, `lint`, and `.golangci.yml` (default linters + gofmt, errcheck, staticcheck)
- [ ] implement `config.Load(getenv func(string) string) (Config, error)` reading the `BOOKSYNC_*` variables with defaults and validation (see Server configuration)
- [ ] implement `api.NewServer(cfg, deps) http.Handler`: Go 1.22 pattern routing, JSON error helper in `respond.go`, slog request logging, `GET /healthz`, JSON 404/405
- [ ] wire `main.go`: load config, build handler, `http.Server` with timeouts (ReadHeader 10 s, Read/Write 60 s, Idle 120 s), graceful shutdown on SIGINT/SIGTERM via `signal.NotifyContext`
- [ ] write table-driven tests for config defaults and env overrides
- [ ] write tests for invalid config values (bad duration, negative history, non-numeric size) and for `/healthz` + unknown route → JSON 404 via httptest
- [ ] run `go test -race ./...` and `make lint` - must pass before Task 2

### Task 2: SQLite store, embedded migrations and users repository

**Files:**
- Create: `internal/store/store.go`
- Create: `internal/store/migrate.go`
- Create: `internal/store/migrations/0001_init.sql`
- Create: `internal/store/users.go`
- Create: `internal/store/store_test.go`
- Create: `internal/store/users_test.go`
- Modify: `cmd/booksync-server/main.go`

- [ ] implement `store.Open(ctx, path)` with `modernc.org/sqlite`: WAL, `foreign_keys=ON`, `busy_timeout=5000`, `_txlock=immediate`; `Close()`
- [ ] implement migration runner: `embed` `migrations/*.sql`, apply in order inside a tx, track in `schema_migrations`, idempotent on re-open
- [ ] add `0001_init.sql` with `users`, `devices`, `vault_versions` (see Database schema)
- [ ] implement users repo: `CreateUser`, `UserByUsername`, `UserByID`, `UpdateCredentials`, `DeleteUser`; sentinel errors `ErrNotFound`, `ErrUsernameTaken`
- [ ] wire `store.Open`/`Close` into `main.go`
- [ ] write tests: migrations idempotent on re-open; user CRUD success against a real DB in `t.TempDir()`
- [ ] write tests: duplicate username → `ErrUsernameTaken`; missing user → `ErrNotFound`; `DeleteUser` cascades to `devices` and `vault_versions` rows
- [ ] run `go test -race ./...` - must pass before Task 3

### Task 3: Credential hashing and device tokens

**Files:**
- Create: `internal/auth/credentials.go`
- Create: `internal/auth/credentials_test.go`
- Create: `internal/auth/token.go`
- Create: `internal/auth/token_test.go`

- [ ] implement `Hasher.Hash(ctx, authKey) (hash, salt, error)` / `Hasher.Verify(ctx, authKey, hash, salt) (bool, error)` with Argon2id (m = 19 MiB, t = 2, p = 1, 32 B) and `subtle.ConstantTimeCompare`; a semaphore (default 4) caps concurrent hashing and memory
- [ ] implement `Hasher.DummyVerify(ctx)` for unknown usernames so login timing does not reveal account existence
- [ ] implement `NewDeviceToken() (plain string, hash []byte)` (32 random bytes, base64url, `bst_` prefix) and `HashToken(plain)` (SHA-256), plus `ValidateAuthKey` (exactly 32 bytes)
- [ ] write tests: hash/verify round trip, wrong key fails, distinct salts per call, semaphore honors context cancellation
- [ ] write tests: token prefix/length/uniqueness, deterministic hashing, malformed tokens and wrong-length auth keys rejected
- [ ] run `go test -race ./...` - must pass before Task 4

### Task 4: Prelogin, registration and login endpoints

**Files:**
- Create: `internal/store/devices.go`
- Create: `internal/store/devices_test.go`
- Create: `internal/api/validate.go`
- Create: `internal/api/validate_test.go`
- Create: `internal/api/auth_handlers.go`
- Create: `internal/api/auth_handlers_test.go`
- Modify: `internal/api/server.go`

- [ ] implement devices repo: `CreateDevice`, `DeviceByTokenHash`, `TouchDevice` (sliding expiry), `ListDevices`, `DeleteDevice`, `DeleteDevicesExcept`
- [ ] implement validation in `validate.go`: username (trim + lowercase, `[a-z0-9._-]{3,64}`), authKey (32 B), iterations ≥ 600000, wrappedVaultKey ≤ 256 B, deviceName 1–64 chars
- [ ] implement `GET /v1/auth/prelogin`: returns the stored KDF params, or the identical defaults for unknown usernames
- [ ] implement `POST /v1/auth/register` (403 `registration_closed` when disabled; 409 `username_taken`) → 201 `{userId, deviceId, deviceToken}`
- [ ] implement `POST /v1/auth/login` → 200 with token + `wrappedVaultKey`; unknown user or wrong key → 401 `invalid_credentials`, using `DummyVerify` for unknown users
- [ ] write tests: devices repo CRUD + expiry; register → prelogin → login happy path; prelogin response shape identical for known and unknown users
- [ ] write table-driven tests for validation errors, duplicate username 409, wrong authKey 401, registration closed 403
- [ ] run `go test -race ./...` - must pass before Task 5

### Task 5: Auth middleware, devices and account management endpoints

**Files:**
- Create: `internal/api/middleware.go`
- Create: `internal/api/middleware_test.go`
- Create: `internal/api/account_handlers.go`
- Create: `internal/api/account_handlers_test.go`
- Modify: `internal/api/server.go`

- [ ] implement `requireDevice` middleware: Bearer `bst_…` token → device + user in the request context; 401 `unauthorized` when missing, unknown or expired; `TouchDevice` at most once per hour
- [ ] implement `POST /v1/auth/logout`, `GET /v1/devices` (with `current` flag), `DELETE /v1/devices/{id}` (own devices only, otherwise 404)
- [ ] implement `POST /v1/account/password`: verify `currentAuthKey`, update credentials and wrapped key, revoke all other devices, all in one tx
- [ ] implement `POST /v1/account/delete`: verify `authKey`, delete the user (cascade)
- [ ] write table-driven middleware tests: no header, wrong scheme/prefix, revoked, expired, valid
- [ ] write tests: device list/revoke incl. cross-user isolation (404); password change revokes other devices and the old key stops working; account delete removes all rows; wrong key → 401
- [ ] run `go test -race ./...` - must pass before Task 6

### Task 6: Vault version storage with history pruning

**Files:**
- Create: `internal/store/vault.go`
- Create: `internal/store/vault_test.go`

- [ ] implement `LatestVault(ctx, userID)` (`ErrNotFound` when the user has no vault yet)
- [ ] implement `PutVault(ctx, userID, deviceID, expected *int64, ciphertext, keep int) (int64, error)`: one immediate tx; `expected == nil` means "must be empty"; mismatch → `*VersionConflictError{Current}`; insert `version+1`; prune versions older than the newest `keep`
- [ ] implement `ListVaultVersions` (version, created_at, device name via LEFT JOIN, size) and `VaultVersion(ctx, userID, version)`
- [ ] write tests: first put requires empty; sequential puts increment; stale expected → conflict carrying the current version; pruning keeps exactly N; per-user isolation
- [ ] write a concurrency test: N goroutines `PutVault` with the same expected version → exactly one succeeds, the rest get conflicts (run under `-race`)
- [ ] run `go test -race ./...` - must pass before Task 7

### Task 7: Vault HTTP endpoints with ETag concurrency

**Files:**
- Create: `internal/api/vault_handlers.go`
- Create: `internal/api/vault_handlers_test.go`
- Modify: `internal/api/server.go`

- [ ] implement `GET /v1/vault`: 200 octet-stream + `ETag: "<v>"`; 304 when `If-None-Match` matches; 404 `vault_empty`
- [ ] implement `PUT /v1/vault`: require `If-Match` or `If-None-Match: *` (else 428); `http.MaxBytesReader` at `BOOKSYNC_MAX_VAULT_BYTES` (413); `BSV1` magic sanity check (400 `invalid_vault`); 412 `version_conflict` with `currentVersion`; 200 `{version}` + ETag
- [ ] implement `GET /v1/vault/versions` and `GET /v1/vault/versions/{version}`
- [ ] write tests for the full flow: put(`*`) → get → put(If-Match) → get with matching ETag → 304 → history list → get old version
- [ ] write tests for errors: missing precondition 428, stale If-Match 412 with current version, oversize 413, bad magic 400, another user's version 404, unauthenticated 401
- [ ] run `go test -race ./...` - must pass before Task 8

### Task 8: Abuse protection: rate limiting and request limits

**Files:**
- Create: `internal/api/ratelimit.go`
- Create: `internal/api/ratelimit_test.go`
- Modify: `internal/api/server.go`
- Modify: `internal/config/config.go`

- [ ] implement keyed token-bucket limiter on `golang.org/x/time/rate` with idle-entry eviction and an injectable clock
- [ ] apply to `/v1/auth/*`: per client IP (10/min, burst 10) and per username on login (5/min); respond 429 `rate_limited` with `Retry-After`
- [ ] resolve client IP from `RemoteAddr`, or from the first `X-Forwarded-For` hop only when `BOOKSYNC_TRUST_PROXY_HEADERS=true`
- [ ] cap JSON request bodies at 64 KiB (413)
- [ ] write tests: limiter allows burst then blocks, refills with fake time, evicts idle keys
- [ ] write tests: 429 + `Retry-After` on auth endpoints; `X-Forwarded-For` ignored unless trusted; oversized JSON → 413
- [ ] run `go test -race ./...` - must pass before Task 9

### Task 9: Container image and self-hosting bundle

**Files:**
- Create: `deploy/Dockerfile`
- Create: `deploy/docker-compose.yml`
- Create: `deploy/Caddyfile`
- Create: `deploy/.env.example`
- Create: `cmd/booksync-server/healthcheck.go`
- Create: `cmd/booksync-server/healthcheck_test.go`
- Modify: `cmd/booksync-server/main.go`

- [ ] add multi-stage `Dockerfile`: `golang:1.24` with `CGO_ENABLED=0 -trimpath -ldflags "-s -w -X main.version=…"` → `gcr.io/distroless/static-debian12:nonroot`; `VOLUME /data`; `EXPOSE 8080`
- [ ] add `booksync-server healthcheck` subcommand (GET `/healthz` on the local port, exit 0/1) used by Docker `HEALTHCHECK`, since distroless has no curl
- [ ] add `docker-compose.yml` (`booksync` + `caddy` with automatic HTTPS for `${BOOKSYNC_DOMAIN}`, named volumes, `restart: unless-stopped`, `BOOKSYNC_TRUST_PROXY_HEADERS=true`) and `Caddyfile`
- [ ] add `.env.example` documenting every `BOOKSYNC_*` variable
- [ ] write tests for the healthcheck subcommand against httptest servers (200 → exit 0; 500 or unreachable → exit 1)
- [ ] verify `docker compose -f deploy/docker-compose.yml config` and `docker build -f deploy/Dockerfile .` succeed (if Docker is available locally)
- [ ] run `go test -race ./...` - must pass before Task 10

### Task 10: Extension project scaffold and dual-browser build

**Files:**
- Create: `extension/package.json`
- Create: `extension/tsconfig.json`
- Create: `extension/eslint.config.js`
- Create: `extension/vitest.config.ts`
- Create: `extension/build.mjs`
- Create: `extension/scripts/manifest.mjs`
- Create: `extension/scripts/manifest.test.ts`
- Create: `extension/manifests/base.json`
- Create: `extension/manifests/chromium.json`
- Create: `extension/manifests/firefox.json`
- Create: `extension/src/background/index.ts`

- [ ] set up the npm project (strict TypeScript, `webextension-polyfill`, dev deps from Context) with scripts `build`, `build:e2e`, `typecheck`, `lint`, `test`, `e2e`, `package`
- [ ] add manifests:
  - base MV3: `bookmarks`, `storage`, `alarms`; `optional_host_permissions` for `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`; popup + options
  - Chromium override: `background.service_worker`, `minimum_chrome_version: "120"`
  - Firefox override: `background.scripts`, `browser_specific_settings.gecko` id + `strict_min_version: "128.0"`
- [ ] implement `scripts/manifest.mjs`: a pure deep-merge of base + browser override that stamps `version` from `package.json`; the `--e2e` flag adds `http://127.0.0.1/*` to `host_permissions` so tests skip the permission prompt
- [ ] implement `build.mjs`: esbuild bundles of the background, popup and options entries into `dist/chromium` and `dist/firefox` (`dist-e2e/*` for the e2e build)
- [ ] write tests for manifest merge per target (background shape, gecko block only for Firefox, e2e host permission only with the flag, version stamped)
- [ ] verify `npm run build` output loads and `npx web-ext lint -s dist/firefox` passes
- [ ] run `npm run typecheck && npm run lint && npm test` - must pass before Task 11

### Task 11: Client crypto: SyncID, key derivation, key wrapping, vault cipher

**Files:**
- Create: `extension/src/crypto/syncid.ts`
- Create: `extension/src/crypto/syncid.test.ts`
- Create: `extension/src/crypto/keys.ts`
- Create: `extension/src/crypto/keys.test.ts`
- Create: `extension/src/crypto/vault-cipher.ts`
- Create: `extension/src/crypto/vault-cipher.test.ts`

- [ ] implement `syncid.ts`: `generateSyncId()`, `formatSyncId()` (`BS1-` + Crockford base32 + check char, grouped), `parseSyncId()` (tolerant input, typed `invalid_checksum` / `invalid_format` errors)
- [ ] implement `keys.ts`: `normalizeUsername`, `deriveKeys(username, password, syncId, iterations)` → `{authKey, kek}` per the Cryptography spec; `generateVaultKey`, `wrapVaultKey`, `unwrapVaultKey` (unwrapped key non-extractable)
- [ ] implement `vault-cipher.ts`: `encryptVault(doc, vaultKey, username)` → `BSV1 ‖ iv ‖ ct` over gzip (`CompressionStream`) JSON with AAD; `decryptVault` with typed errors `bad_magic`, `auth_failed`, `bad_format`
- [ ] write tests: SyncID round trip, case/dash/space/I-L-O tolerance; property test that any single-character typo fails the checksum
- [ ] write tests: `deriveKeys` matches a pinned vector (iterations = 1000 for speed); a different SyncID or password yields a different authKey; wrap/unwrap round trip; unwrap with a wrong kek or username fails
- [ ] write tests: vault encrypt/decrypt round trip; fresh IV per call; one flipped byte → `auth_failed`; wrong-username AAD → `auth_failed`; bad magic
- [ ] run `npm test` - must pass before Task 12

### Task 12: Vault document model and tree validation

**Files:**
- Create: `extension/src/model/vault.ts`
- Create: `extension/src/model/vault.test.ts`
- Create: `extension/src/model/url.ts`
- Create: `extension/src/model/url.test.ts`

- [ ] define `VaultDoc`, `VNode`, root GUID constants, `emptyDoc()`, `newGuid()` (12-char base64url)
- [ ] implement `validateTree(doc)` → violations list (missing roots, unreachable/duplicate-parented nodes, cycles, dangling child refs, bookmark without url, folder without children)
- [ ] implement `treesEqual(a, b)` (ignores `seq`, `writtenBy`, `writtenAt`, `dateAdded`), `countNodes`, and `parseVaultDoc(json)` rejecting unknown `format` with `unsupported_format`
- [ ] implement `url.ts` `matchKey(url)` for dedupe (WHATWG `URL.href`, lowercase host, default port dropped; invalid URLs fall back to the trimmed string)
- [ ] write tests: `validateTree` detects each violation type and accepts valid trees
- [ ] write tests: `treesEqual` ignores metadata but detects title/url/parent/order changes; `parseVaultDoc` errors; `matchKey` normalization cases
- [ ] run `npm test` - must pass before Task 13

### Task 13: Three-way merge engine

**Files:**
- Create: `extension/src/sync/merge.ts`
- Create: `extension/src/sync/merge.test.ts`
- Create: `extension/src/sync/merge.property.test.ts`
- Create: `extension/test/arbitraries.ts`

- [ ] implement `merge3(base, local, remote) → {doc, stats}` following every row of the Merge rules table (existence, field merge, parent merge, child ordering, orphan relocation, cycle repair, immutable roots)
- [ ] compute `stats`: adds/updates/moves/deletes per direction (toward local, toward remote) and resolved conflicts, for the guard and the popup summary
- [ ] add fast-check arbitraries in `test/arbitraries.ts`: random valid trees and random edit scripts (add/rename/re-url/move/reorder/delete)
- [ ] write table-driven tests for each Merge rules row, including: add/add, edit/edit same and different, edit-vs-delete in both directions, folder delete vs child add, move/move conflict, move cycle (A→B locally, B→A remotely), reorder on one side + insert on the other, both reorder
- [ ] write property tests: `merge3(b, x, b) ≡ x`, `merge3(b, b, x) ≡ x`, `merge3(b, x, x) ≡ x`; output always passes `validateTree`; deterministic; a node changed on exactly one side is never lost
- [ ] run `npm test` - must pass before Task 14

### Task 14: First-sync matching for bootstrap and device join

**Files:**
- Create: `extension/src/sync/first-sync.ts`
- Create: `extension/src/sync/first-sync.test.ts`

- [ ] implement `firstSync(local, remote | null) → {doc, guidRemap}`:
  - `remote == null` bootstraps the account from `local`.
  - Otherwise, match top-down as described under First sync and return `guidRemap` so the idMap can rebind local ids to remote GUIDs.
- [ ] place unmatched local nodes under their matched parent, after the nearest matched local predecessor; never delete or rename remote content
- [ ] write tests: identical trees → no additions; partial overlap → no duplicates; duplicate URLs in one folder matched 1:1; same-titled folders under different parents not cross-matched
- [ ] write tests: empty local; empty remote (bootstrap); unmatched local folder carries its whole subtree; result passes `validateTree`
- [ ] run `npm test` - must pass before Task 15

### Task 15: Local extension state in IndexedDB

**Files:**
- Create: `extension/src/storage/db.ts`
- Create: `extension/src/storage/db.test.ts`
- Create: `extension/src/storage/state.ts`
- Create: `extension/src/storage/state.test.ts`

- [ ] implement `db.ts`: minimal promise wrapper over IndexedDB (`booksync` DB, stores `kv` and `idmap`, versioned upgrade)
- [ ] implement `state.ts` typed accessors for `session`, `vaultKey`, `sync` and `idMap` (see Local extension state), plus `clearAccount()`, which never touches browser bookmarks
- [ ] write tests (fake-indexeddb): round trip of each accessor; DB upgrade from empty; `clearAccount` wipes everything
- [ ] write tests: idMap stays bidirectionally consistent on rebind/remove; vault `CryptoKey` persists, remains usable and non-extractable
- [ ] ⚠️ if Node's structured clone cannot store `CryptoKey` under fake-indexeddb, cover that one assertion in the Task 23 e2e instead and note it here
- [ ] run `npm test` - must pass before Task 16

### Task 16: Browser bookmark adapters for Chromium and Firefox

**Files:**
- Create: `extension/src/browser/adapter.ts`
- Create: `extension/src/browser/chromium.ts`
- Create: `extension/src/browser/chromium.test.ts`
- Create: `extension/src/browser/firefox.ts`
- Create: `extension/src/browser/firefox.test.ts`
- Create: `extension/test/fakes/bookmarks.ts`

- [ ] define the `BookmarksAdapter` interface (`flavor`, `readTree`, `create`, `update`, `move`, `remove`, `removeTree`, `rootMap`) and the `LocalNode` type
- [ ] implement the Chromium adapter:
  - resolve roots by `folderType`, preferring `syncing !== true`, with fallback to ids `1/2/3`;
  - skip `managed` folders;
  - materialize `menu________` as a "Bookmarks Menu" folder under Other bookmarks on demand;
  - expose `nativeSyncDetected`.
- [ ] implement the Firefox adapter: fixed root GUIDs; separators filtered on read; sync index ↔ native index translation around separators on writes
- [ ] implement `test/fakes/bookmarks.ts`: an in-memory bookmarks API with per-flavor root ids, index semantics, Firefox separators and privileged-URL rejection, and an unmodifiable Chromium managed folder
- [ ] write tests (Chromium): root resolution for legacy, `folderType`, and local + account storage variants; menu folder materialization; managed folder ignored; `nativeSyncDetected`
- [ ] write tests (Firefox): separators hidden from reads; moves and creates land at the correct native index with separators present; privileged URL create rejects with a recognizable error
- [ ] run `npm test` - must pass before Task 17

### Task 17: Local tree projection

**Files:**
- Create: `extension/src/browser/projection.ts`
- Create: `extension/src/browser/projection.test.ts`

- [ ] implement `project(adapter, idMap, base, skipped) → VaultDoc`: map roots to canonical GUIDs, map local ids to GUIDs (allocating and persisting new ones), exclude the materialized menu folder from Other's children
- [ ] re-insert `skipped` nodes from `base` after their base predecessor in the same parent
- [ ] write tests: stable GUIDs across repeated projections; new local nodes get fresh GUIDs; the menu folder maps to `menu________` on Chromium
- [ ] write tests: skipped node re-inserted at the right position; skipped node whose parent vanished is dropped; output passes `validateTree` for both flavors
- [ ] run `npm test` - must pass before Task 18

### Task 18: Applying the merged tree to the browser

**Files:**
- Create: `extension/src/browser/apply.ts`
- Create: `extension/src/browser/apply.test.ts`

- [ ] implement `diffTrees(localProjection, merged) → ops`, ordered as folder creates (top-down), bookmark creates, title/url updates, per-folder moves and reorders (minimal moves), then removals bottom-up (`removeTree` when a whole subtree goes)
- [ ] implement `applyOps(adapter, ops, idMap, skipped)`:
  - update `idMap` on create and remove;
  - a create the browser rejects goes into `skipped`, and the apply continues;
  - any other failure aborts with a partial-progress error.
- [ ] drop GUIDs from `skipped` once `merged` no longer contains them
- [ ] write tests: op ordering (parent before child, removals last); a single reorder needs one move; applying to the Chromium and Firefox fakes yields a projection `treesEqual` to `merged`
- [ ] write tests: privileged URL on Firefox → skipped and not seen as a local deletion on the next projection; a mid-apply failure leaves `idMap` consistent with the browser
- [ ] run `npm test` - must pass before Task 19

### Task 19: Typed API client and fake server

**Files:**
- Create: `extension/src/api/client.ts`
- Create: `extension/src/api/client.test.ts`
- Create: `extension/test/fakes/server.ts`
- Create: `extension/test/fakes/server.test.ts`

- [ ] define the `ApiClient` interface for every endpoint in the Server API table, and implement `HttpApiClient(baseUrl, getToken)` with binary vault bodies as `Uint8Array`
- [ ] implement `getVault(ifNoneMatch?)` → `ok | not_modified | empty`, and `putVault(body, expected: number | 'none')` → `{version} | {conflict}`
- [ ] map errors to typed `ApiError` (`unauthorized`, `invalid_credentials`, `rate_limited` + `retryAfter`, `too_large`, `network`, `server`); refuse non-HTTPS server URLs except `localhost`/`127.0.0.1`
- [ ] implement `test/fakes/server.ts`: in-memory `ApiClient` with users, devices, versioned vault, 304/412 semantics and history
- [ ] write tests (mocked `fetch`): method, path, headers and body per endpoint; ETag round trip; 304/404/412 handling; error mapping incl. `Retry-After`; non-HTTPS rejection
- [ ] write tests for the fake server's conflict and history semantics, so later tests rely on correct behavior
- [ ] run `npm test` - must pass before Task 20

### Task 20: Sync engine orchestration and mass-deletion guard

**Files:**
- Create: `extension/src/sync/engine.ts`
- Create: `extension/src/sync/engine.test.ts`
- Create: `extension/src/sync/guard.ts`
- Create: `extension/src/sync/guard.test.ts`
- Create: `extension/src/sync/convergence.property.test.ts`

- [ ] implement `syncOnce(deps, {confirmed})` exactly as in the Sync algorithm, returning `SyncResult` (`ok`, `needs_confirmation`, `conflict_exhausted`, `rollback_detected`, `error`) and persisting it as the status
- [ ] implement `guard.ts`: block when deletions in either direction exceed 25 % of nodes **and** number at least 20; return a summary for the UI; `confirmed` bypasses it once
- [ ] write tests:
  - first-device bootstrap and second-device join (no duplicates);
  - local-only change uploads, remote-only change applies;
  - a 304 makes no PUT;
  - 412 retry, then success, and `conflict_exhausted` after 3 conflicts.
- [ ] write tests: lower `seq` → `rollback_detected`; empty vault after a previous sync → `rollback_detected`; guard blocks in both directions; `confirmed` proceeds; a partial apply failure leaves `base` unchanged and the next run recovers
- [ ] write a convergence property test:
  - 2–3 simulated devices (Chromium and Firefox fakes) against one fake server;
  - random interleavings of edits and syncs;
  - after a final round, every projection is `treesEqual` and valid.
- [ ] run `npm test` - must pass before Task 21

### Task 21: Background scheduler and message bus

**Files:**
- Create: `extension/src/background/scheduler.ts`
- Create: `extension/src/background/scheduler.test.ts`
- Create: `extension/src/background/messages.ts`
- Create: `extension/src/background/router.ts`
- Create: `extension/src/background/router.test.ts`
- Modify: `extension/src/background/index.ts`

- [ ] implement the scheduler:
  - single-flight sync with a "dirty" re-run flag;
  - bookmark events (`onCreated/onChanged/onMoved/onRemoved/onChildrenReordered`) debounced by 3 s;
  - events ignored while applying;
  - Chromium `onImportBegan/onImportEnded` pause syncing;
  - `alarms` "poll" every 1 min, plus a sync on `runtime.onStartup`.
- [ ] implement backoff on network/server errors (30 s → 15 min, jittered) and honor `Retry-After`; `unauthorized` clears the session and sets status `signed_out`
- [ ] define the typed request/response union in `messages.ts` (`getStatus`, `syncNow`, `confirmPendingSync`, `register`, `login`, `logout`, `listDevices`, `revokeDevice`, `changePassword`, `deleteAccount`, `listVersions`, `restoreVersion`, `getEmergencyKit`); `router.ts` validates and dispatches
- [ ] publish status to `storage.session` so the popup and options pages update via `storage.onChanged`
- [ ] write tests (fake timers): debounce coalesces bursts; single-flight + dirty re-run; backoff schedule and `Retry-After`; 401 → `signed_out`; events during apply ignored
- [ ] write tests: router rejects unknown and malformed messages, and dispatches each message type
- [ ] run `npm test` - must pass before Task 22

### Task 22: Account flows: register, login, password change, delete

**Files:**
- Create: `extension/src/background/account.ts`
- Create: `extension/src/background/account.test.ts`
- Create: `extension/src/background/emergency-kit.ts`
- Create: `extension/src/background/emergency-kit.test.ts`

- [ ] implement `register`: prelogin defaults → generate SyncID + vault key → derive → wrap → `POST /register` → persist session, SyncID and key → bootstrap sync; return the SyncID and kit
- [ ] implement `login`: prelogin → derive → login → unwrap the vault key (failure → `invalid_credentials`) → persist → join sync
- [ ] implement `logout` (revoke + `clearAccount`), `changePassword` (derive with the stored SyncID, rewrap, POST, this device stays signed in), `deleteAccount(password)`, and device list/revoke
- [ ] implement `emergency-kit.ts`: plaintext kit with server URL, username, SyncID, creation date and recovery warning, never the password; enforce a 10-character minimum password client-side
- [ ] write tests (fake server, reduced iterations): register on device 1, then login on device 2, recovers the same vault key; wrong password or wrong SyncID → `invalid_credentials`
- [ ] write tests: after `changePassword` the old password fails, the new one works and other devices are revoked; `deleteAccount` clears local state; the kit contains the SyncID and never the password
- [ ] run `npm test` - must pass before Task 23

### Task 23: Options page and e2e harness

**Files:**
- Create: `extension/src/ui/options/options.html`
- Create: `extension/src/ui/options/options.ts`
- Create: `extension/src/ui/options/options.css`
- Create: `extension/src/ui/shared/rpc.ts`
- Create: `extension/playwright.config.ts`
- Create: `extension/e2e/fixtures.ts`
- Create: `extension/e2e/options.spec.ts`

- [ ] build the server step: validate the URL (HTTPS unless localhost), call `permissions.request` for the origin from the click handler, probe `/healthz`
- [ ] build the sign-up form:
  - show the SyncID once;
  - offer "Download emergency kit" (.txt);
  - require the "I saved my SyncID" checkbox before continuing.
- [ ] build the sign-in form (username, password, SyncID with live format validation)
- [ ] build the signed-in view: account info, native-sync warning (Chromium), devices with revoke, change password, delete account (type the username to confirm), logout
- [ ] implement the Playwright fixture: `go build` the server → spawn it on a free port with a temp DB → launch a Chromium persistent context with `dist-e2e/chromium` → resolve the extension id from the service worker URL
- [ ] write e2e tests:
  - registration shows the SyncID and the kit downloads;
  - after logout, sign-in with a wrong SyncID shows an error and the correct one succeeds;
  - the devices list shows the current device;
  - revoking a device works.
- [ ] run `npm test && npm run e2e` - must pass before Task 24

### Task 24: Toolbar popup: status, sync now, confirmations

**Files:**
- Create: `extension/src/ui/popup/popup.html`
- Create: `extension/src/ui/popup/popup.ts`
- Create: `extension/src/ui/popup/popup.css`
- Create: `extension/e2e/popup.spec.ts`

- [ ] render the popup states:
  - signed out (button opening the options page);
  - syncing;
  - ok ("last synced 2 min ago");
  - error with retry;
  - `needs_confirmation` (counts per direction, with Confirm and Pause sync);
  - `rollback_detected` (explanation + link to History).
- [ ] add a "Sync now" button and live updates via `storage.onChanged`
- [ ] set the toolbar badge `!` on error or pending confirmation; clear it on `ok`
- [ ] write e2e tests: popup shows ok after the sign-in sync; Sync now triggers a sync (server version increments)
- [ ] write an e2e test for mass deletion: seed 40 bookmarks, sync, delete 30 via the service worker → popup asks for confirmation → Confirm applies and the server reflects it
- [ ] run `npm test && npm run e2e` - must pass before Task 25

### Task 25: Version history and restore

**Files:**
- Create: `extension/src/sync/restore.ts`
- Create: `extension/src/sync/restore.test.ts`
- Modify: `extension/src/background/router.ts`
- Modify: `extension/src/ui/options/options.html`
- Modify: `extension/src/ui/options/options.ts`
- Modify: `extension/e2e/options.spec.ts`

- [ ] implement `restoreVersion(v)`: fetch and decrypt version `v` → set `seq = lastSeq + 1` → PUT with `If-Match` current (retry on 412) → `syncOnce({confirmed: true})` so this browser follows; other browsers pick it up through a normal merge
- [ ] add an options "History" section: version, date, device and size, with Restore behind a confirmation dialog
- [ ] write tests: the restored remote equals the old content with a higher `seq`; other devices' rollback check passes; a concurrent write during restore → 412 → retry succeeds
- [ ] write an e2e test: add bookmarks → restore an earlier version → the added bookmarks disappear locally
- [ ] run `npm test && npm run e2e` - must pass before Task 26

### Task 26: Cross-profile end-to-end sync test

**Files:**
- Create: `extension/e2e/sync.spec.ts`
- Modify: `extension/e2e/fixtures.ts`

- [ ] extend the fixture with two Chromium profiles (A, B) on one server, plus helpers to run `browser.bookmarks.*` in each service worker and to trigger `syncNow`
- [ ] write an e2e test: A registers with existing bookmarks; B, with overlapping bookmarks, signs in → both trees identical, no duplicates
- [ ] write e2e tests:
  - create, rename, move and delete in A show up in B after sync;
  - A deletes a folder while B adds a child → the child survives in the nearest ancestor on both.
- [ ] write an e2e test for the event-driven path: a bookmark created in A with no manual sync → the server version increments within 10 s
- [ ] write an e2e test for E2EE at rest: a unique seeded title and URL do not appear anywhere in the SQLite file
- [ ] run `npm run e2e` - must pass before Task 27

### Task 27: CI pipeline and release packaging

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `Makefile`
- Modify: `extension/package.json`
- Modify: `extension/scripts/manifest.test.ts`

- [ ] add CI jobs:
  - `go`: gofmt check, `go vet`, golangci-lint, `go test -race ./...`;
  - `extension`: `npm ci`, typecheck, lint, test, build, `web-ext lint`;
  - `e2e`: needs both; Playwright Chromium + the Go toolchain.
- [ ] add `make test` (Go + extension unit tests), `make e2e`, and `make package`, which produces `booksync-chromium-<ver>.zip` and `booksync-firefox-<ver>.zip` (via `web-ext build`)
- [ ] make `package.json` the single source of the extension version; the server version comes from the git tag via `-X main.version`
- [ ] write tests: manifest version stamping and package naming in `manifest.test.ts`
- [ ] run `make test` locally - must pass before Task 28

### Task 28: Verify acceptance criteria
- [ ] verify all eight acceptance criteria from the Overview are implemented, each mapped to at least one automated test
- [ ] verify edge cases: separators, privileged URLs, menu root on Chromium, account-storage roots, rollback, mass deletion, 412 storms
- [ ] run the full test suite: `make test`
- [ ] run the e2e tests: `make e2e`
- [ ] verify coverage: `go test -cover ./...` ≥ 80 % for `internal/...`; `npx vitest run --coverage` ≥ 90 % for `src/sync` and `src/crypto`

### Task 29: [Final] Update documentation
- [ ] write `README.md`: what and why, architecture diagram, security model summary, self-hosting with docker compose, installing the extension (unpacked builds and stores), development setup, test commands
- [ ] write `docs/protocol.md`: the Cryptography spec, vault format and Server API as a normative reference for future clients (e.g. a Go CLI or Safari)
- [ ] create `CLAUDE.md`: repo layout, Go and TS conventions, test commands, merge invariants that must hold
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification**
- Real Firefox via `web-ext run`. Covers what Playwright cannot automate: separators, the Bookmarks Menu, privileged URLs, sign-in persisting across a browser restart.
- Edge, Brave, Vivaldi and Opera, loaded unpacked. Watch Opera's Speed Dial and Vivaldi's root quirks.
- Chrome with Google bookmark sync on: confirm the native-sync warning appears and no duplicate loops occur.
- Large libraries (10k bookmarks): merge time, vault size, upload latency, service-worker CPU.
- An MV3 service worker suspended longer than 30 s: remote changes still arrive through the alarm; offline/online transitions; laptop sleep.

**Security review**
- Independent review of the crypto design: key separation, AAD binding, nonce handling, rollback detection, emergency-kit UX.
- Size Argon2id and the semaphore against the server's RAM; check rate limits behind Caddy.
- `govulncheck ./...`, `npm audit`, and periodic dependency updates.

**External systems and deployment**
- Developer accounts and listings on the Chrome Web Store, Microsoft Edge Add-ons and Firefox AMO, with a privacy policy (E2EE simplifies it).
- DNS for `BOOKSYNC_DOMAIN`; Caddy obtains TLS automatically.
- Backups of the SQLite volume (contents are already encrypted), e.g. a scheduled `sqlite3 .backup` or Litestream.

**Future iterations**
- A push channel (SSE/WebSocket) for instant propagation; Safari Web Extension; separators, tags and keywords; an Argon2id client KDF through WASM (KDF params are already versioned).
- A per-record vault model if libraries outgrow snapshots; an admin CLI (list or disable users, invite-only registration); optional PostgreSQL backend.
