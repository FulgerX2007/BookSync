# BookSync: E2E-encrypted cross-browser bookmark sync

## Overview
- BookSync keeps bookmarks in two-way sync across every browser a person uses through a self-hosted Go server. v1 covers the Chromium family (Chrome, Edge, Brave, Vivaldi, Opera) and Firefox.
- **Problem:** native browser sync only works inside one vendor's ecosystem. People who use several browsers end up with divergent bookmark sets, and the native options store bookmarks with a third party.
- **Key properties:**
  - **Two-way, near-live sync.** Local changes reach the server within ~5 s (debounced). Other browsers pick them up within ~1 min (polling with ETag/304).
  - **End-to-end encrypted.** The server stores only ciphertext and cannot read titles, URLs or folder structure. All it can infer is the approximate library size, from the vault size.
  - **Multi-user, self-hosted.** One CGO-free Go binary in a distroless container with SQLite storage, plus Caddy for automatic TLS.
  - **Login model.** Registration generates a **SyncID**, a client-side 128-bit secret. Signing in on another browser needs **username + password + SyncID**.
- **Integration:** this is a greenfield project; the repository is empty apart from this plan. The plan establishes the Go server layout (`cmd/`, `internal/`, `deploy/`) and the TypeScript WebExtension (`extension/`).

### Acceptance criteria
1. A user registers from the extension in browser A and receives a SyncID plus a downloadable emergency kit.
2. The user signs in from browser B, from a different family (e.g. Chrome → Firefox), with username + password + SyncID. Existing bookmarks on both sides merge without duplicates.
3. Create, rename, move, reorder and delete in any signed-in browser propagate to all others. The change reaches the server within ~5 s, and other browsers within ~1 min.
4. Concurrent edits on several browsers converge to identical trees on every device. Once converged, further syncs change nothing and upload nothing.
5. The server database contains no plaintext titles or URLs. A wrong SyncID or password cannot sign in. The server operator cannot decrypt vaults.
6. A sync that would delete a large share of bookmarks pauses for user confirmation. The server keeps the 10 most recent versions plus one per day for 30 days, and any of them can be restored.
7. Users can list and revoke devices. A password change re-wraps the vault key and signs out the other devices; its "a device was lost" option also rotates the vault key and SyncID. Account deletion removes all server data.
8. `docker compose up` with `deploy/docker-compose.yml` runs a working HTTPS server.

### Non-goals for v1
- Safari, mobile browsers, a Go CLI client.
- Firefox separators, tags and keywords; favicons; Chromium managed (policy) bookmarks; `dateAdded` (browsers do not allow setting it).
- Sharing folders between users, admin UI, password or SyncID recovery (impossible by design under E2EE).
- A push channel (SSE/WebSocket), PostgreSQL, an Argon2id client KDF. All are listed under Post-Completion as follow-ups.

## Context (from discovery)
- **Repository:** empty apart from this plan. Branch `claude/epic-ride-n5y2t8`; remote `github.com/FulgerX2007/BookSync`.
- **Toolchains available:** Go 1.24.7 locally (the module pins `toolchain go1.27.2`, fetched automatically); Node 22 / npm 10; Chromium preinstalled for Playwright (`/opt/pw-browsers`).
- ⚠️ **Go version changed during Task 2:** `modernc.org/sqlite` v1.60 needs Go ≥ 1.26, and Go 1.24 is out of support. `go.mod` now says `go 1.26.0` + `toolchain go1.27.2`. golangci-lint must be v2.14+ built with Go 1.27 (`GOLANGCI_LINT` in the Makefile).
- **Existing patterns:** none yet. Conventions this plan establishes:
  - Go: standard `cmd/` + `internal/` layout, stdlib `net/http` with Go 1.22+ pattern routing, `log/slog`, table-driven tests with stdlib `testing` + `net/http/httptest`, real SQLite in `t.TempDir()` instead of store mocks.
  - Extension: TypeScript (strict), Manifest V3, one codebase built twice (Chromium and Firefox), vitest + fast-check, Playwright for e2e.
  - No `webextension-polyfill`. Both targets have promise-based MV3 APIs, so a typed accessor (`globalThis.browser ?? chrome`) is enough. This also keeps the Chromium-only fields `folderType`, `syncing` and `onImport*` typed.
- **Dependencies identified:**
  - Go: `modernc.org/sqlite` (CGO-free), `golang.org/x/crypto/argon2`, `golang.org/x/time/rate`.
  - Extension dev: `typescript`, `@types/chrome`, `esbuild`, `vitest`, `@vitest/coverage-v8`, `fast-check`, `fake-indexeddb`, `@playwright/test`, `eslint` + `typescript-eslint`, `web-ext`.

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
  - Concurrency-sensitive code (vault versioning, credential rotation) gets parallel-goroutine tests under `-race`.
- **Unit tests (extension):** `cd extension && npm test` (vitest), using these fakes:
  - an in-memory `bookmarks` API with Chromium **or** Firefox semantics (`test/fakes/bookmarks.ts`);
  - an in-memory server implementing `ApiClient` (`test/fakes/server.ts`);
  - `fake-indexeddb` for local state.
- **Fake fidelity matters.** Firefox is covered mainly through its fake, so the bookmarks fake must reproduce the behaviours that cause real bugs:
  - Chrome's pre-removal index for same-parent `move`, versus Firefox's final-position index;
  - URL canonicalization on save;
  - `remove` rejecting non-empty folders;
  - Firefox separators and privileged-URL rejection;
  - the Chromium managed folder;
  - each browser's own set of events.
- **Property-based tests (fast-check)** cover the highest-risk code:
  - the 3-way merge invariants;
  - multi-device convergence (2–3 simulated browsers of mixed flavors syncing random edits against one fake server), including a **settle** assertion: after convergence, another round produces zero browser ops and zero uploads. This catches sync loops of any cause.
- **E2E tests (Playwright):** `cd extension && npm run e2e`.
  - Chromium persistent contexts load the unpacked e2e build of the extension and talk to the real Go server binary, which runs on a free port with a temp DB.
  - Two profiles simulate two browsers.
  - Use `channel: 'chromium'` (new headless) so extensions load in headless mode.
  - UI tasks add their e2e specs in the same task.
- **Deployment smoke test:** `deploy/smoke.sh` runs `docker compose up`, waits for healthy, then hits `/healthz` and registers one user through Caddy. It runs in CI and locally when Docker is available.
- **Firefox:** covered by adapter and engine unit tests against the Firefox-flavored fake. A real-Firefox run is a manual check under Post-Completion.

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
              │ SQLite: users · devices · vault_versions (ciphertext only, retention policy)  │
              └───────────────────────────────────────────────────────────────────────────────┘
                                   ▲ Caddy (automatic HTTPS) in docker-compose
```

**Key design decisions**
1. **Encrypted whole-tree snapshot with optimistic locking.** Chosen over a per-record store or an operation log.
   - Each user has one encrypted vault blob with a server version number. Clients upload with `If-Match`; a stale version gets `412`, and the client re-merges.
   - The server stays trivial, the tree is always consistent, and the server learns almost nothing.
   - History and restore come free: the server retains old blobs.
   - Cost: every change uploads the whole tree. That is about 200–300 KB gzipped for 5k bookmarks, which is acceptable with debouncing.
2. **All merging happens in the client.** E2EE forces this. The merge rules are deterministic, so every device computes the same result; the server is versioned dumb storage.
3. **The SyncID is a client-side secret mixed into key derivation** (two-secret key derivation, as with 1Password's Secret Key).
   - It never reaches the server, so a stolen server database cannot be cracked offline: an attacker would need the password **and** 128 random bits.
   - Losing the SyncID means losing the account. It is shown once at registration as an emergency kit, and stays viewable on signed-in devices.
4. **A random vault key is wrapped by a password-derived KEK.**
   - A normal password change only re-wraps the key; the vault is never re-encrypted.
   - The "a device was lost" option rotates the vault key and SyncID in one atomic server request.
5. **Crash-safe apply.**
   - Ordering: merge, apply locally, upload, then advance `base` only after both sides succeed.
   - Every `idMap` entry is persisted as soon as its browser call resolves, and a `pendingApply` marker lets an interrupted apply rebind its own creations instead of duplicating them.
   - Folders are removed bottom-up with `bookmarks.remove`, which refuses non-empty folders, so a bookmark the user just added is never deleted by mistake.
6. **Polling instead of push for remote changes.** `alarms` fire every 1 min and send `GET /v1/vault` with `If-None-Match`, which is cheap thanks to 304s. MV3 service workers cannot hold sockets reliably, so the push channel is deferred.
7. **Conflict policy: edit beats delete. On a true conflict, the version already on the server wins** (first-committed wins). The policy is simple, deterministic and convergent.
8. **Device state survives revocation.** A 401 drops only the device token and the vault key. `base`, `idMap` and the SyncID stay, so signing in again resumes a guarded 3-way merge instead of a fresh join that would bring back deleted bookmarks.
9. **Stack: TypeScript in the extension, Go on the server.** The extension uses native WebCrypto, with no WASM in MV3 service workers. SQLite through `modernc.org/sqlite` keeps the server a single static binary.

## Technical Details

### Cryptography (client-side, WebCrypto)
```
u         = normalizeUsername(username)        // trim + lowercase, must match [a-z0-9._-]{3,64}
sid       = 16 random bytes = SyncID           // generated at registration, NEVER sent to the server
stretched = PBKDF2-HMAC-SHA256(utf8(password), salt = SHA-256("booksync/v1|" + u), iterations = 600000, 32 B)
authKey   = HKDF-SHA256(ikm = stretched, salt = sid, info = "booksync/v1/auth", 32 B)   → sent to the server
kek       = HKDF-SHA256(ikm = stretched, salt = sid, info = "booksync/v1/kek",  32 B)   → AES-256-GCM key, stays on the client
vaultKey  = 32 random bytes, generated once at registration (AES-256-GCM)
wrapped   = iv(12) ‖ AES-GCM(kek, iv, aad = "booksync/v1/wrap|" + u, vaultKey)        → stored on the server AND locally
vault     = "BSV1" ‖ iv(12) ‖ AES-GCM(vaultKey, iv, aad = "booksync/v1/vault|" + u, gzip(JSON(VaultDoc)))
server    : stores Argon2id(authKey, salt = random 16 B, m = 19 MiB, t = 2, p = 1); compares in constant time
```
- **Vault key handling.**
  - The client keeps a **non-extractable** `CryptoKey` for daily use, plus the `wrapped` bytes in `session.wrappedVaultKey`.
  - At registration the raw key bytes exist only long enough to be wrapped and imported.
  - Re-wrapping (password change) never touches the non-extractable key. The client derives the old kek, decrypts the stored `wrapped` bytes into a temporary raw key, encrypts it under the new kek, and discards the raw bytes.
- **Key rotation** ("a device was lost"):
  - The client generates a new vault key **and** a new SyncID, then re-encrypts the current tree.
  - It sends the new credentials and the new vault in one atomic `POST /v1/account/password`.
  - The server replaces the history, since the new key can't decrypt the old versions, and revokes all other devices.
  - The user receives a new emergency kit.
- **Downgrade protection.** The client accepts only `kdf = "pbkdf2-sha256"` with `iterations ≥ 600000` from prelogin and login. A malicious server cannot weaken derivation.
- **SyncID display format:** `BS1-` + Crockford base32 of the 16 bytes (26 chars) + 2 check chars (value mod 1021), in seven groups of four.
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
}
interface VaultDoc {
  format: 1;           // unknown higher format → "update the extension" error, never overwrite
  seq: number;         // +1 per upload, inside the ciphertext → rollback detection
  writtenBy: string;   // deviceId
  writtenAt: number;   // ms epoch
  nodes: Record<Guid, VNode>; // includes the 4 roots
}
```

### Browser mapping
| Canonical root GUID | Firefox | Chromium family |
|---|---|---|
| `toolbar_____` | Bookmarks Toolbar | Bookmarks bar (`folderType: "bookmarks-bar"`, legacy id `1`) |
| `unfiled_____` | Other Bookmarks | Other bookmarks (`"other"`, legacy id `2`) |
| `mobile______` | Mobile Bookmarks | Mobile bookmarks (`"mobile"`, legacy id `3`) |
| `menu________` | Bookmarks Menu | folder "Bookmarks Menu" inside Other bookmarks (see below) |

- **Pinned roots.**
  - The native root ids chosen on first sync are persisted in `rootPins`.
  - If a pinned root disappears (for example the user signs out of a Chrome account that held it), sync stops with `roots_changed`.
  - The user resolves it with "Re-pin and rejoin": roots are resolved again and `firstSync` runs, which never deletes anything.
- **Chromium account storage and native sync.**
  - Chromium 134+ can expose two permanent folders per `folderType` (a local one and a Google-account one). Prefer the one with `syncing !== true`.
  - If the pinned roots are, or later become, natively synced, sync pauses with `native_sync_detected` until the user acknowledges it.
  - The warning explains why: two BookSync-enabled browsers on the same Google account duplicate bookmarks endlessly. Native sync copies a node, the other BookSync gives it a new GUID, and the cycle repeats.
- **Chromium "Bookmarks Menu" folder.**
  - Discovery: before creating the folder, look for an existing folder titled "Bookmarks Menu" directly under Other bookmarks and reuse it.
  - The folder's native id is pinned with the roots.
  - If the pinned folder is missing (the user deleted it), the projection carries the `menu________` subtree over from `base`, so it never counts as a deletion, and the next apply recreates the folder.
- **Index translation.** Adapters position writes by anchor ("after sibling P") and compute the native index from the folder's current children at write time. The translation:
  - skips GUIDs in `skipped` (present in the vault, absent from the browser);
  - skips native-only nodes: Firefox separators and the Chromium menu folder under Other bookmarks;
  - applies Chrome's same-parent `move` rule, where the index counts positions before the node is removed, so moving down needs `+1`. Firefox treats the index as the final position.
- **URL canonicalization.**
  - Browsers rewrite URLs on save (trailing slash, punycode, percent-encoding).
  - After each create or update, the applier stores the URL as read back from the browser (`nativeUrl`) in the node's `idMap` entry.
  - When the native URL still equals `nativeUrl`, projection emits the vault URL. Rewrites therefore never look like local edits and never ping-pong between browsers.
- **Firefox separators** are filtered out on read and never synced.
- **Skipped nodes** are bookmarks a browser refuses to create (e.g. Firefox rejects privileged URL schemes such as `javascript:` or `chrome:`). Their GUIDs go into `skipped`, and the projection re-inserts them from `base`, so they never look like local deletions.

### Server API
Binary fields in JSON (`authKey`, `wrappedVaultKey`, `vault`) use base64url without padding. Errors look like `{"error":{"code":"…","message":"…"}}`. Device auth uses `Authorization: Bearer bst_<base64url 32 B>`. JSON bodies are capped at 64 KiB, except a password change carrying a rotation, which is capped at `BOOKSYNC_MAX_VAULT_BYTES × 4/3 + 64 KiB`.

| Method & path | Auth | Request | Responses |
|---|---|---|---|
| `GET /healthz` | – | – | 200 |
| `GET /v1/auth/prelogin?username=` | – | – | 200 `{kdf, iterations}` (identical defaults for unknown users) |
| `POST /v1/auth/register` | – | `{username, authKey, kdf, iterations, wrappedVaultKey, deviceName}` | 201 `{userId, deviceId, deviceToken}` · 400 · 403 `registration_closed` · 409 `username_taken` |
| `POST /v1/auth/login` | – | `{username, authKey, deviceName}` | 200 `{userId, deviceId, deviceToken, wrappedVaultKey, kdf, iterations}` · 401 `invalid_credentials` |
| `POST /v1/auth/logout` | device | – | 204 |
| `GET /v1/devices` | device | – | 200 `[{id, name, createdAt, lastSeenAt, current}]` |
| `DELETE /v1/devices/{id}` | device | – | 204 · 404 |
| `POST /v1/account/password` | device | `{currentAuthKey, newAuthKey, kdf, iterations, newWrappedVaultKey, rotation?: {expectedVersion, vault}}` | 204 (other devices revoked) · with `rotation`: 200 `{version}` + ETag, history replaced by the new vault · 400 · 401 · 412 `version_conflict` · 413 |
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
- **Per-connection pragmas in the DSN.** `database/sql` pools connections, so the pragmas go in the DSN, where every pooled connection gets them: `?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_txlock=immediate`.
- The current vault is the row with `MAX(version)` for the user.
- `PutVault` runs as a single immediate transaction: compare the version, insert `version+1`, apply retention. SQLite's single writer makes this race-free.
- **Retention:** keep the newest `KEEP_RECENT` versions plus the newest version of each UTC day within the last `KEEP_DAYS`; delete the rest. A burst of edits therefore can't flush yesterday's restore points.

### Server configuration (env)
| Variable | Default | Purpose |
|---|---|---|
| `BOOKSYNC_ADDR` | `:8080` | listen address |
| `BOOKSYNC_DB_PATH` | `/data/booksync.db` | SQLite file |
| `BOOKSYNC_ALLOW_REGISTRATION` | `true` | open/close sign-ups; set `false` once your accounts exist (there are no per-user quotas) |
| `BOOKSYNC_MAX_VAULT_BYTES` | `10485760` | max encrypted vault size |
| `BOOKSYNC_VAULT_KEEP_RECENT` | `10` | newest versions always kept |
| `BOOKSYNC_VAULT_KEEP_DAYS` | `30` | also keep one version per day for this many days |
| `BOOKSYNC_TOKEN_TTL` | `2160h` | sliding device-token expiry (90 days) |
| `BOOKSYNC_TRUST_PROXY_HEADERS` | `false` | take the client IP from the **rightmost** `X-Forwarded-For` entry (the one Caddy appends) |
| `BOOKSYNC_LOG_LEVEL` | `info` | slog level |

### Sync algorithm (`syncOnce`, runs single-flight in the background)
0. **Skip conditions.** Skip the run when signed out, paused, `roots_changed`, `native_sync_detected` without acknowledgment, or `now < nextAttemptAt`.
1. **Crash recovery.** If `pendingApply` exists, a previous apply was interrupted. Rebind unmapped browser nodes that exactly match a `pendingApply` node (same parent GUID, kind, title, URL) to that node's GUID.
2. Note the bookmark-event counter `E`. Project the browser tree into a `VaultDoc` (`local`) using `idMap`, `rootPins`, `skipped` and `base`.
3. Send `GET /v1/vault` with `If-None-Match: version`.
   - 304: `remote = base`.
   - 404: `remote = null`.
   - 200: decrypt into `remote`.
4. **Rollback check.** If `remote.seq < lastSeq`, or `remote == null` while `base != null`, return `rollback_detected`. Two recovery actions are offered:
   - **Use this browser's bookmarks:** upload `local` as `seq = lastSeq + 1`. This is the right choice after an operator restored a server backup.
   - **Accept server version:** set `lastSeq = remote.seq` and continue at step 5 with the guard active.
5. **Merge.**
   - No `base` (fresh device or rejoin): `firstSync(local, remote)`, which bootstraps or joins with dedupe.
   - Otherwise: `merge3(base, local, remote)`.
6. **Guard.**
   - Trigger: deletions in either direction exceed 25 % of nodes **and** number at least 20.
   - When it triggers, store `pendingConfirmation = {remoteVersion, deletionsToLocal, deletionsToRemote}` and return `needs_confirmation`.
   - A confirmation bypasses the guard only if the new merge runs against the same `remoteVersion` and deletes no more than the confirmed counts. Otherwise the user is asked again.
7. **Apply.**
   - If the event counter changed since step 2, restart from step 1.
   - Otherwise persist `pendingApply = merged`, then apply the ops (see Task 20), persisting each `idMap` entry as its call resolves.
   - If `remove` hits a non-empty folder, the user added something meanwhile: restart from step 1.
8. **Upload.** If `merged ≠ remote`: set `merged.seq = max(remote.seq, lastSeq) + 1`, encrypt, and `PUT` with `If-Match` (or `If-None-Match: *`). On 412, restart from step 1.
9. **Commit.** Persist `base = merged`, `version` and `lastSeq`, clear `pendingApply`, status `ok`.
- At most 3 restarts per run (any cause). After that, status `conflict_exhausted` and the scheduler backs off.
- Events caused by our own apply mark the scheduler dirty. The follow-up run is a cheap no-op: a 304, an empty diff and no PUT.

### Merge rules (`merge3(base, local, remote)`, per GUID)
**Definitions**
- **Edit:** a change to `title`, `url` or parent. A child-order change alone is not an edit.
- **Reordered:** a folder whose child sequence, restricted to children present in both versions, differs from `base`.
- **Nearest surviving ancestor:** walk the parent chain of the side that kept the descendant.

| Situation | Result |
|---|---|
| unchanged on both sides | keep |
| changed on one side only (title, url, parent, child order) | take that side |
| identical change on both sides | take it |
| `title`/`url` changed differently on both | remote wins (first-committed wins) |
| parent changed differently on both | remote wins |
| added on one side | add |
| deleted on one side, unchanged or only reordered on the other | delete |
| deleted on one side, edited on the other | keep the edited node (edit beats delete) |
| folder deleted on one side, descendants added or edited on the other | folder stays deleted; surviving descendants move to the nearest surviving ancestor (Firefox Dogear rule), falling back to `unfiled_____` |
| deleted on both | delete |
| child order: only one side reordered | that side's order; the other side's new children are inserted after their predecessor |
| child order: both reordered | remote order; local-only new children inserted after their local predecessor, else appended |
| merge produces a cycle | use the remote parent for nodes in the cycle; if still cyclic, move them to `unfiled_____` |
| roots | never added, deleted, moved or renamed (titles are localized per browser) |

**First sync** (`firstSync`, for a device without `base`):
- The device's nodes are matched against the remote tree **by GUID first**, for nodes still in `idMap` from an earlier membership. The rest are matched by content, top-down:
  - folders by title within their matched parent;
  - bookmarks by normalized URL, with the title as tie-breaker;
  - each remote node is matched at most once.
- The result is the remote tree plus the unmatched local nodes. Nothing is ever deleted or renamed on the remote side.
- A joining device adopts the account's titles and ordering for matched items and keeps its own extras.
- Re-login of the **same** `userId` with an existing `base` (after a 401) uses `merge3`, not `firstSync`, so deletions made elsewhere are not undone.

### Local extension state (IndexedDB `booksync`)
- `session`: serverUrl, username, userId, deviceId, deviceToken, syncId, kdf iterations, wrappedVaultKey.
- `vaultKey`: a non-extractable `CryptoKey`, stored by structured clone.
- `sync`:
  - `base` (last synced `VaultDoc`), `version` (server ETag), `lastSeq`;
  - `skipped` GUIDs, `pendingApply`, `pendingConfirmation`;
  - `status`, `paused`, `nextAttemptAt`;
  - `rootPins` (native ids for the roots and the Chromium menu folder), `nativeSyncAck`.
- `idmap`: browser-local id ↔ `{guid, nativeUrl?}`.
- **Logout** clears everything. A **401** clears only `deviceToken` and `vaultKey`. Browser bookmarks are never touched by either.

### Security model
| The server learns | The server cannot learn |
|---|---|
| usernames, device names, client IPs, sync timestamps, number of versions, vault size per version (a rough proxy for library size) | titles, URLs, folder structure, exact bookmark count, password, SyncID, vault key |

- **Stolen server DB:** offline guessing needs both the password and the 128-bit SyncID, which is infeasible.
- **Online guessing:** `authKey` also depends on the SyncID, so online guessing is just as infeasible.
  - Rate limits (per IP, and per IP + username) exist for abuse control.
  - There is deliberately no global per-username lockout, which would let anyone lock a user out of signing in on new devices.
- **Malicious or compromised server:**
  - It cannot read or forge vault contents (AEAD).
  - Replaying an old vault is detected by the encrypted `seq` (`rollback_detected`).
  - It cannot weaken the KDF (client-side minimums).
  - It can still deny service.
  - It does not serve the client code; the extension is installed from the stores, which is an advantage over web-based E2EE.
- **Compromised or lost device:** the attacker holds the SyncID and the vault key.
  - Revoking the device stops it syncing, but does **not** protect future vaults.
  - The user must change the password with "a device was lost". That rotates the vault key and SyncID, and vaults written afterwards are unreadable with the stolen keys.
- **Username enumeration** through a registration `409` is accepted for self-hosted deployments.
- **Out of scope:** malicious extension updates. Mitigation: minimal dependencies.

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

- [x] init module `github.com/FulgerX2007/BookSync` (`go 1.24`, later raised to 1.26, see Context); add `Makefile` targets `build`, `run`, `test`, `lint`, and `.golangci.yml` (default linters + gofmt, errcheck, staticcheck)
- [x] implement `config.Load(getenv func(string) string) (Config, error)` reading the `BOOKSYNC_*` variables with defaults and validation (see Server configuration)
- [x] implement `api.NewServer(cfg, deps) http.Handler`: Go 1.22 pattern routing, JSON error helper in `respond.go`, slog request logging, `GET /healthz`, JSON 404/405
- [x] wire `main.go`: load config, build handler, `http.Server` with timeouts (ReadHeader 10 s, Read/Write 60 s, Idle 120 s), graceful shutdown on SIGINT/SIGTERM via `signal.NotifyContext`
- [x] write table-driven tests for config defaults and env overrides
- [x] write tests for invalid config values (bad duration, negative retention, non-numeric size) and for `/healthz` + unknown route → JSON 404 via httptest
- [x] run `go test -race ./...` and `make lint` - must pass before Task 2
- [x] ➕ added `internal/api/helpers_test.go` and `cmd/booksync-server/main_test.go` (run starts and shuts down on cancel; invalid config rejected)

### Task 2: SQLite store, embedded migrations and users repository

**Files:**
- Create: `internal/store/store.go`
- Create: `internal/store/migrate.go`
- Create: `internal/store/migrations/0001_init.sql`
- Create: `internal/store/users.go`
- Create: `internal/store/store_test.go`
- Create: `internal/store/users_test.go`
- Modify: `cmd/booksync-server/main.go`

- [x] implement `store.Open(ctx, path)` with `modernc.org/sqlite`, setting pragmas through the DSN (`_pragma=foreign_keys(1)`, `_pragma=busy_timeout(5000)`, `_pragma=journal_mode(WAL)`, `_txlock=immediate`) so every pooled connection gets them; `Close()`
- [x] implement migration runner: `embed` `migrations/*.sql`, apply in order inside a tx, track in `schema_migrations`, idempotent on re-open
- [x] add `0001_init.sql` with `users`, `devices`, `vault_versions` (see Database schema)
- [x] implement users repo: `CreateUser`, `UserByUsername`, `UserByID`, `DeleteUser`; sentinel errors `ErrNotFound`, `ErrUsernameTaken`
- [x] wire `store.Open`/`Close` into `main.go`
- [x] write tests: migrations idempotent on re-open; user CRUD success against a real DB in `t.TempDir()`
- [x] write tests: duplicate username → `ErrUsernameTaken`; missing user → `ErrNotFound`; `DeleteUser` cascades to `devices` and `vault_versions`; with `SetMaxOpenConns(4)` and several connections held at once, `PRAGMA foreign_keys` returns 1 on each
- [x] run `go test -race ./...` - must pass before Task 3

### Task 3: Credential hashing and device tokens

**Files:**
- Create: `internal/auth/credentials.go`
- Create: `internal/auth/credentials_test.go`
- Create: `internal/auth/token.go`
- Create: `internal/auth/token_test.go`

- [x] implement `Hasher.Hash(ctx, authKey) (hash, salt, error)` / `Hasher.Verify(ctx, authKey, hash, salt) (bool, error)` with Argon2id (m = 19 MiB, t = 2, p = 1, 32 B) and `subtle.ConstantTimeCompare`; a semaphore (default 4) caps concurrent hashing and memory
- [x] implement `Hasher.DummyVerify(ctx)` for unknown usernames so login timing does not reveal account existence
- [x] implement `NewDeviceToken() (plain string, hash []byte)` (32 random bytes, base64url, `bst_` prefix) and `HashToken(plain)` (SHA-256), plus `ValidateAuthKey` (exactly 32 bytes)
- [x] write tests: hash/verify round trip, wrong key fails, distinct salts per call, semaphore honors context cancellation
- [x] write tests: token prefix/length/uniqueness, deterministic hashing, malformed tokens and wrong-length auth keys rejected
- [x] run `go test -race ./...` - must pass before Task 4
- [x] ➕ stored hashes are prefixed with a one-byte Argon2 parameter-set id, so parameters can change later without invalidating existing hashes

### Task 4: Prelogin, registration and login endpoints

**Files:**
- Create: `internal/store/devices.go`
- Create: `internal/store/devices_test.go`
- Create: `internal/api/validate.go`
- Create: `internal/api/validate_test.go`
- Create: `internal/api/auth_handlers.go`
- Create: `internal/api/auth_handlers_test.go`
- Modify: `internal/api/server.go`

- [x] implement devices repo: `CreateDevice`, `DeviceByTokenHash`, `TouchDevice` (sliding expiry), `ListDevices`, `DeleteDevice`
- [x] implement validation in `validate.go`: username (trim + lowercase, `[a-z0-9._-]{3,64}`), authKey (32 B), `kdf == "pbkdf2-sha256"`, iterations ≥ 600000, wrappedVaultKey ≤ 256 B, deviceName 1–64 chars
- [x] implement `GET /v1/auth/prelogin`: returns the stored KDF params, or the identical defaults for unknown usernames
- [x] implement `POST /v1/auth/register` (403 `registration_closed` when disabled; 409 `username_taken`) → 201 `{userId, deviceId, deviceToken}`
- [x] implement `POST /v1/auth/login` → 200 with token, `wrappedVaultKey` and KDF params; unknown user or wrong key → 401 `invalid_credentials`, using `DummyVerify` for unknown users
- [x] write tests: devices repo CRUD + expiry; register → prelogin → login happy path; prelogin response shape identical for known and unknown users
- [x] write table-driven tests for validation errors, duplicate username 409, wrong authKey 401, registration closed 403
- [x] run `go test -race ./...` - must pass before Task 5
- [x] ➕ `decodeJSON` (64 KiB cap → 413, unknown fields and trailing data → 400) and `auth.NewTestHasher()` (cheap params under an id production hashers reject) were added here; `Deps` carries `Store`, `Hasher` and a `Now` clock

### Task 5: Auth middleware, devices, logout and account deletion

**Files:**
- Create: `internal/api/middleware.go`
- Create: `internal/api/middleware_test.go`
- Create: `internal/api/account_handlers.go`
- Create: `internal/api/account_handlers_test.go`
- Modify: `internal/api/server.go`

- [x] implement `requireDevice` middleware: Bearer `bst_…` token → device + user in the request context; 401 `unauthorized` when missing, unknown or expired; `TouchDevice` at most once per hour
- [x] implement `POST /v1/auth/logout`, `GET /v1/devices` (with `current` flag), `DELETE /v1/devices/{id}` (own devices only, otherwise 404)
- [x] implement `POST /v1/account/delete`: verify `authKey`, delete the user (cascade)
- [x] write table-driven middleware tests: no header, wrong scheme/prefix, revoked, expired, valid
- [x] write tests: device list/revoke incl. cross-user isolation (404); account delete removes all rows; wrong key → 401
- [x] run `go test -race ./...` - must pass before Task 6

### Task 6: Vault version storage with retention

**Files:**
- Create: `internal/store/vault.go`
- Create: `internal/store/vault_test.go`

- [x] implement `LatestVault(ctx, userID)` (`ErrNotFound` when the user has no vault yet)
- [x] implement `PutVault(ctx, userID, deviceID, expected *int64, ciphertext, retention, now) (int64, error)`: one immediate tx; `expected == nil` means "must be empty"; mismatch → `*VersionConflictError{Current}`; insert `version+1`; apply retention (newest `KeepRecent` + newest per UTC day within `KeepDays`)
- [x] implement `ListVaultVersions` (version, created_at, device name via LEFT JOIN, size) and `VaultVersion(ctx, userID, version)`
- [x] write tests: first put requires empty; sequential puts increment; stale expected → conflict carrying the current version; per-user isolation
- [x] write retention tests with injected timestamps: a burst of 50 puts today keeps the newest 10 plus one per earlier day; days older than `KeepDays` are dropped
- [x] write a concurrency test: N goroutines `PutVault` with the same expected version → exactly one succeeds, the rest get conflicts (run under `-race`)
- [x] run `go test -race ./...` - must pass before Task 7

### Task 7: Vault HTTP endpoints with ETag concurrency

**Files:**
- Create: `internal/api/vault_handlers.go`
- Create: `internal/api/vault_handlers_test.go`
- Modify: `internal/api/server.go`

- [x] implement `GET /v1/vault`: 200 octet-stream + `ETag: "<v>"`; 304 when `If-None-Match` matches; 404 `vault_empty`
- [x] implement `PUT /v1/vault`: require `If-Match` or `If-None-Match: *` (else 428); `http.MaxBytesReader` at `BOOKSYNC_MAX_VAULT_BYTES` (413); `BSV1` magic sanity check (400 `invalid_vault`); 412 `version_conflict` with `currentVersion`; 200 `{version}` + ETag
- [x] implement `GET /v1/vault/versions` and `GET /v1/vault/versions/{version}`
- [x] write tests for the full flow: put(`*`) → get → put(If-Match) → get with matching ETag → 304 → history list → get old version
- [x] write tests for errors: missing precondition 428, stale If-Match 412 with current version, oversize 413, bad magic 400, another user's version 404, unauthenticated 401
- [x] run `go test -race ./...` - must pass before Task 8

### Task 8: Password change and key rotation endpoint

**Files:**
- Create: `internal/store/credentials.go`
- Create: `internal/store/credentials_test.go`
- Modify: `internal/api/account_handlers.go`
- Modify: `internal/api/account_handlers_test.go`

- [x] implement `ChangeCredentials(ctx, userID, keepDeviceID, creds, rotation *VaultRotation)` in one immediate tx:
  - update auth hash/salt, KDF params and wrapped key;
  - with `rotation`: check `expectedVersion` (conflict error), insert the new vault version and delete every older version;
  - delete all devices except `keepDeviceID`.
- [x] implement `POST /v1/account/password`: verify `currentAuthKey`, validate new fields and the optional `rotation {expectedVersion, vault}` (base64url, `BSV1` magic, size cap with the route-specific body limit); 204 / 401 / 412 / 413
- [x] write store tests: plain change keeps history; rotation leaves exactly one version (the new one); stale `expectedVersion` → conflict and nothing changes (tx rolled back); other devices deleted, current kept
- [x] write API tests: old authKey fails afterwards and the new one works; a revoked device gets 401; oversize rotation vault 413; wrong current key 401
- [x] run `go test -race ./...` - must pass before Task 9

### Task 9: Abuse protection: rate limiting and request limits

**Files:**
- Create: `internal/api/ratelimit.go`
- Create: `internal/api/ratelimit_test.go`
- Modify: `internal/api/server.go`
- Modify: `internal/config/config.go`

- [x] implement keyed token-bucket limiter on `golang.org/x/time/rate` with idle-entry eviction and an injectable clock
- [x] apply to `/v1/auth/*`: per client IP (10/min, burst 10) and per (IP, username) on login (5/min); no global per-username limit (see Security model); respond 429 `rate_limited` with `Retry-After`
- [x] resolve client IP from `RemoteAddr`, or from the **rightmost** `X-Forwarded-For` entry only when `BOOKSYNC_TRUST_PROXY_HEADERS=true`
- [x] cap JSON request bodies at 64 KiB (413), except the password route with rotation
- [x] write tests: limiter allows burst then blocks, refills with fake time, evicts idle keys
- [x] write tests: 429 + `Retry-After` on auth endpoints; the rightmost `X-Forwarded-For` entry is used only when trusted, and a spoofed leftmost entry is ignored; oversized JSON → 413
- [x] run `go test -race ./...` - must pass before Task 10
- [x] ➕ `config.go` needed no change (`BOOKSYNC_TRUST_PROXY_HEADERS` already existed); IPv6 clients are rate-limited per /64; the 64 KiB JSON cap was built in Task 4 and is tested here at the API level

### Task 10: Container image and self-hosting bundle

**Files:**
- Create: `deploy/Dockerfile`
- Create: `deploy/docker-compose.yml`
- Create: `deploy/Caddyfile`
- Create: `deploy/.env.example`
- Create: `deploy/smoke.sh`
- Create: `cmd/booksync-server/healthcheck.go`
- Create: `cmd/booksync-server/healthcheck_test.go`
- Modify: `cmd/booksync-server/main.go`

- [x] add multi-stage `Dockerfile`:
  - build stage: `golang:1.27` with `CGO_ENABLED=0 -trimpath -ldflags "-s -w -X main.version=…"`, plus `mkdir /data`;
  - final stage: `gcr.io/distroless/static-debian12:nonroot` with `COPY --from=build --chown=65532:65532 /data /data`, so named volumes inherit nonroot ownership; `VOLUME /data`; `EXPOSE 8080`.
- [x] add `booksync-server healthcheck` subcommand (GET `/healthz` on the local port, exit 0/1) used by Docker `HEALTHCHECK`, since distroless has no curl
- [x] add `docker-compose.yml` and `Caddyfile`:
  - `booksync` only `expose`s 8080 and publishes no host port, so traffic must go through Caddy;
  - `caddy` publishes 80/443 with automatic HTTPS for `${BOOKSYNC_DOMAIN}`;
  - named volumes, `restart: unless-stopped`, `BOOKSYNC_TRUST_PROXY_HEADERS=true`.
- [x] add `.env.example` documenting every `BOOKSYNC_*` variable, incl. "set `BOOKSYNC_ALLOW_REGISTRATION=false` after creating your accounts"
- [x] add `deploy/smoke.sh`: `docker compose up -d` with a local domain (`tls internal`), wait for healthy, curl `/healthz` and register one user through Caddy, `docker compose down -v`
- [x] write tests for the healthcheck subcommand against httptest servers (200 → exit 0; 500 or unreachable → exit 1)
- [x] run `deploy/smoke.sh` if Docker is available locally (it always runs in CI, Task 28); run `go test -race ./...` - must pass before Task 11
- [x] ⚠️ in this dev environment the egress proxy re-signs TLS, so the image was built from a scratch copy of the Dockerfile that trusts the proxy CA, then `SMOKE_BUILD=0 deploy/smoke.sh` passed (health via the Docker healthcheck, TLS through Caddy, registration). ➕ `smoke.sh` gained `SMOKE_BUILD=0` to reuse a prebuilt image

### Task 11: Extension project scaffold and dual-browser build

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
- Create: `extension/src/platform/ext.ts`
- Create: `extension/src/background/index.ts`
- Create: `extension/src/ui/popup/popup.html`
- Create: `extension/src/ui/popup/popup.ts`
- Create: `extension/src/ui/options/options.html`
- Create: `extension/src/ui/options/options.ts`

- [x] set up the npm project (strict TypeScript, dev deps from Context) with scripts `build`, `build:e2e`, `typecheck`, `lint`, `test`, `e2e`, `package`
- [x] add `src/platform/ext.ts`: `export const ext = (globalThis.browser ?? globalThis.chrome) as typeof chrome`, the single entry point to WebExtension APIs
- [x] add manifests:
  - base MV3: `bookmarks`, `storage`, `alarms`; `optional_host_permissions` for `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`; popup + options;
  - Chromium override: `background.service_worker`, `minimum_chrome_version: "120"`;
  - Firefox override: `background.scripts`; `browser_specific_settings.gecko` with id, `strict_min_version: "128.0"` and the `data_collection_permissions` declaration that current AMO policy requires (confirm with `web-ext lint`).
- [x] implement `scripts/manifest.mjs`: a pure deep-merge of base + browser override that stamps `version` from `package.json`; the `--e2e` flag adds `http://127.0.0.1/*` to `host_permissions` so tests skip the permission prompt
- [x] implement `build.mjs`: esbuild bundles of the background, popup and options entries into `dist/chromium` and `dist/firefox` (`dist-e2e/*` for the e2e build); the popup and options stubs exist from this task on, so the build and lint work immediately
- [x] write tests for manifest merge per target (background shape, gecko block only for Firefox, e2e host permission only with the flag, version stamped)
- [x] verify `npm run build` output loads and `npx web-ext lint -s dist/firefox` passes
- [x] run `npm run typecheck && npm run lint && npm test` - must pass before Task 12
- [x] ⚠️ deviations:
  - TypeScript is pinned to 6.0.3, because TypeScript 7 (the native port) is not yet supported by typescript-eslint.
  - Firefox `strict_min_version` is 140, not 128, because `data_collection_permissions` needs it; `gecko_android` is set to 142 to keep `web-ext lint` clean.
  - `ext()` is a lazy function, so tests can install fakes.
  - Bundles are IIFE, so no module background is needed.
  - `npm audit` flags only `web-ext`'s dev-only transitive dependencies; the shipped extension has no runtime dependencies.

### Task 12: Vault document model and tree validation

**Files:**
- Create: `extension/src/model/vault.ts`
- Create: `extension/src/model/vault.test.ts`
- Create: `extension/src/model/url.ts`
- Create: `extension/src/model/url.test.ts`

- [x] define `VaultDoc`, `VNode`, root GUID constants, `emptyDoc()`, `newGuid()` (12-char base64url)
- [x] implement `validateTree(doc)` → violations list (missing roots, unreachable/duplicate-parented nodes, cycles, dangling child refs, bookmark without url, folder without children)
- [x] implement `treesEqual(a, b)` (ignores `seq`, `writtenBy`, `writtenAt`), `countNodes`, `serializeVaultDoc`/`parseVaultDoc` (bytes ↔ doc), with unknown `format` → `unsupported_format`
- [x] implement `url.ts` `matchKey(url)` for dedupe (WHATWG `URL.href`, lowercase host, default port dropped; invalid URLs fall back to the trimmed string)
- [x] write tests: `validateTree` detects each violation type and accepts valid trees
- [x] write tests: `treesEqual` ignores metadata but detects title/url/parent/order changes; `parseVaultDoc` errors; `matchKey` normalization cases
- [x] run `npm test` - must pass before Task 13
- [x] ➕ `extension/test/builders.ts`: compact `doc()` tree builder and `outline()` renderer shared by the tests that follow

### Task 13: Client crypto: SyncID, key derivation, key wrapping, vault cipher

**Files:**
- Create: `extension/src/crypto/syncid.ts`
- Create: `extension/src/crypto/syncid.test.ts`
- Create: `extension/src/crypto/keys.ts`
- Create: `extension/src/crypto/keys.test.ts`
- Create: `extension/src/crypto/vault-cipher.ts`
- Create: `extension/src/crypto/vault-cipher.test.ts`

- [x] implement `syncid.ts`: `generateSyncId()`, `formatSyncId()` (`BS1-` + Crockford base32 + check char, grouped), `parseSyncId()` (tolerant input, typed `invalid_checksum` / `invalid_format` errors)
- [x] implement `keys.ts`:
  - `normalizeUsername`;
  - `assertKdfParams(kdf, iterations)` (downgrade guard);
  - `deriveKeys(username, password, syncId, iterations)` → `{authKey, kek}` per the Cryptography spec;
  - `createVaultKey(kek, username)` → `{key: non-extractable CryptoKey, wrapped: Uint8Array}`;
  - `unwrapVaultKey(wrapped, kek, username)` → non-extractable key;
  - `rewrapVaultKey(wrapped, oldKek, newKek, username)` → new wrapped bytes, with the temporary raw key discarded.
- [x] implement `vault-cipher.ts`: `encryptVault(doc, vaultKey, username)` → `BSV1 ‖ iv ‖ ct` over gzip (`CompressionStream`) of `serializeVaultDoc`, with AAD; `decryptVault` with typed errors `bad_magic`, `auth_failed`, plus `parseVaultDoc` errors
- [x] write tests: SyncID round trip, case/dash/space/I-L-O tolerance; property test that any single-character typo fails the checksum
- [x] write tests for keys:
  - `deriveKeys` matches a pinned vector (iterations = 1000, test-only bypass of the minimum);
  - a different SyncID or password yields a different authKey;
  - `assertKdfParams` rejects a low iteration count or an unknown KDF;
  - wrapping, starting from a vault key that exists only as a non-extractable `CryptoKey` plus its wrapped bytes: `rewrapVaultKey` succeeds, and the key unwrapped under the new kek decrypts data encrypted with the original key;
  - a wrong kek or username fails.
- [x] write tests: vault encrypt/decrypt round trip; fresh IV per call; one flipped byte → `auth_failed`; wrong-username AAD → `auth_failed`; bad magic
- [x] run `npm test` - must pass before Task 14
- [x] ⚠️ the SyncID has **two** check characters (value mod 1021, a prime): one base32 character cannot detect every typo, and this avoids Crockford's `*~$=` symbols. The format is `BS1-` + seven groups of four.
- [x] ➕ the derivation test vector was computed independently (Python `hashlib.pbkdf2_hmac` + RFC 5869 HKDF), not copied from WebCrypto output. Passwords are NFC-normalized before PBKDF2.

### Task 14: Three-way merge engine

**Files:**
- Create: `extension/src/sync/merge.ts`
- Create: `extension/src/sync/merge.test.ts`
- Create: `extension/src/sync/merge.property.test.ts`
- Create: `extension/test/arbitraries.ts`

- [x] implement `merge3(base, local, remote) → {doc, stats}` following the Merge rules definitions and every table row (existence, field merge, parent merge, child ordering, orphan relocation, cycle repair, immutable roots)
- [x] compute `stats`: adds/updates/moves/deletes per direction (toward local, toward remote) and resolved conflicts, for the guard and the popup summary
- [x] add fast-check arbitraries in `test/arbitraries.ts`: random valid trees and random edit scripts (add/rename/re-url/move/reorder/delete)
- [x] write table-driven tests for each Merge rules row, including:
  - add/add; edit/edit, same and different;
  - edit-vs-delete in both directions; delete vs reorder-only (stays deleted);
  - folder delete vs child add; move/move conflict;
  - move cycle (A→B locally, B→A remotely);
  - reorder on one side + insert on the other; both reorder.
- [x] write property tests: `merge3(b, x, b) ≡ x`, `merge3(b, b, x) ≡ x`, `merge3(b, x, x) ≡ x`; output always passes `validateTree`; deterministic; a node edited on exactly one side is never lost
- [x] run `npm test` - must pass before Task 15
- [x] ➕ also verified with `FC_RUNS=5000` (about 19-node base trees, two edit scripts of up to 15 ops each); children of a folder the merge doesn't place by order rules are appended in guid order

### Task 15: First-sync matching for bootstrap, join and rejoin

**Files:**
- Create: `extension/src/sync/first-sync.ts`
- Create: `extension/src/sync/first-sync.test.ts`

- [x] implement `firstSync(local, remote | null) → {doc, guidRemap}`:
  - `remote == null` bootstraps the account from `local`.
  - Otherwise, match by GUID first, then by content top-down (see First sync), and return `guidRemap` so the idMap can rebind local ids to remote GUIDs.
- [x] place unmatched local nodes under their matched parent, after the nearest matched local predecessor; never delete or rename remote content
- [x] write tests: identical trees → no additions; partial overlap → no duplicates; duplicate URLs in one folder matched 1:1; same-titled folders under different parents not cross-matched
- [x] write tests: GUID match wins over content (renamed bookmark from an earlier membership is not duplicated); empty local; empty remote (bootstrap); unmatched local folder carries its whole subtree; result passes `validateTree`
- [x] run `npm test` - must pass before Task 16
- [x] ➕ property test: for random overlapping trees the result is valid, keeps every remote node unchanged and accounts for every local node; a local guid that exists remotely as the other kind gets a fresh guid

### Task 16: Local extension state in IndexedDB

**Files:**
- Create: `extension/src/storage/db.ts`
- Create: `extension/src/storage/db.test.ts`
- Create: `extension/src/storage/state.ts`
- Create: `extension/src/storage/state.test.ts`

- [x] implement `db.ts`: minimal promise wrapper over IndexedDB (`booksync` DB, stores `kv` and `idmap`, versioned upgrade)
- [x] implement `state.ts` typed accessors for `session`, `vaultKey`, `sync` and `idMap` (entries `{guid, nativeUrl?}`), see Local extension state
- [x] implement `clearAccount()` (logout: everything) and `clearCredentials()` (401: only `deviceToken` + `vaultKey`); neither touches browser bookmarks
- [x] write tests (fake-indexeddb): round trip of each accessor; DB upgrade from empty; `clearAccount` wipes everything; `clearCredentials` keeps `base`, `idMap`, SyncID and `lastSeq`
- [x] write tests: idMap stays bidirectionally consistent on rebind/remove; vault `CryptoKey` persists, remains usable and non-extractable
- [x] Node's structured clone stores `CryptoKey` under fake-indexeddb, so the e2e fallback isn't needed (a unit test covers it)
- [x] run `npm test` - must pass before Task 17

### Task 17: Browser bookmark adapters for Chromium and Firefox

**Files:**
- Create: `extension/src/browser/adapter.ts`
- Create: `extension/src/browser/chromium.ts`
- Create: `extension/src/browser/chromium.test.ts`
- Create: `extension/src/browser/firefox.ts`
- Create: `extension/src/browser/firefox.test.ts`
- Create: `extension/test/fakes/bookmarks.ts`

- [x] define the `BookmarksAdapter` interface (`flavor`, `readTree`, `resolveRoots(pins)`, `create`, `update`, `move`, `remove`, `events`) and the `LocalNode` type. Write positions are sync-space indices plus the target folder's sync children; the adapter does the index translation (see Browser mapping).
- [x] implement the Chromium adapter:
  - resolve roots by `folderType`, preferring `syncing !== true`, with fallback to ids `1/2/3`;
  - check pins: a missing pinned root → `roots_changed`; a pinned root with `syncing === true` → `nativeSyncDetected`;
  - skip `managed` folders;
  - discover or create the "Bookmarks Menu" folder and pin it;
  - apply Chrome's same-parent `move` +1 rule.
- [x] implement the Firefox adapter: fixed root GUIDs; separators filtered on read; sync ↔ native index translation around separators; `events` built only from APIs that exist (Firefox lacks `onChildrenReordered`, `onImportBegan`, `onImportEnded`)
- [x] implement `test/fakes/bookmarks.ts` with fidelity per flavor:
  - root ids;
  - Chrome's pre-removal index for same-parent `move`, versus Firefox's final index;
  - URL canonicalization on save (trailing slash for bare hosts, lowercase host, punycode);
  - `remove` rejecting non-empty folders;
  - Firefox separators and privileged-URL rejection;
  - an unmodifiable Chromium managed folder;
  - each flavor's own event set.
- [x] write tests (Chromium): root resolution for legacy, `folderType`, and local + account storage variants; missing pin → `roots_changed`; `syncing` flip → `nativeSyncDetected`; menu folder rediscovered rather than duplicated; same-parent moves up and down land at the intended sync index
- [x] write tests (Firefox): separators hidden from reads; creates and moves land at the correct native index with separators present; privileged URL create rejects with a recognizable error; missing event APIs don't throw
- [x] run `npm test` - must pass before Task 18
- [x] ⚠️ refinement: writes are positioned by **anchor** (`create(parent, afterId)` / `moveAfter(id, parent, afterId)`), and the adapter computes the native index from the folder's current children at write time. That covers separators, skipped nodes, the menu folder and both move semantics without a separate sync↔native index mapping. Firefox's final-position semantics were confirmed in its Places implementation.
- [x] ➕ a root this Firefox lacks is left unpinned and carried from `base` like the Chromium menu folder; `ensureRoot` rejects writes into it with `BookmarkRejectedError`

### Task 18: Local tree projection

**Files:**
- Create: `extension/src/browser/projection.ts`
- Create: `extension/src/browser/projection.test.ts`

- [x] implement `project(adapter, idMap, base, skipped, pins) → VaultDoc`:
  - map roots to canonical GUIDs;
  - map local ids to GUIDs, allocating and persisting new ones;
  - exclude the pinned menu folder from Other's children and project it as `menu________`.
- [x] when the pinned menu folder is missing, carry the `menu________` subtree over from `base` (never a deletion); re-insert `skipped` nodes from `base` after their base predecessor
- [x] emit the vault URL whenever the native URL equals the entry's `nativeUrl` (canonicalization is not an edit)
- [x] write tests: stable GUIDs across repeated projections; new local nodes get fresh GUIDs; the menu folder maps to `menu________` on Chromium; deleting the menu folder yields no deletions of menu content
- [x] write tests: skipped node re-inserted at the right position; skipped node whose parent vanished is dropped; a browser-rewritten URL projects as the vault URL while a real user URL edit is still detected; output passes `validateTree` for both flavors
- [x] run `npm test` - must pass before Task 19
- [x] ➕ `project()` takes the `LocalTree` the adapter already read, so it stays nearly pure. New GUID bindings are persisted in one transaction (`IdMap.setMany`). Any root absent locally is carried from `base`, not only the menu, and a carried node the browser shows elsewhere is not duplicated.
- [x] ➕ `matchKey` ignores an empty trailing `#`, so browsers that disagree about it still dedupe on join

### Task 19: Typed API client and fake server

**Files:**
- Create: `extension/src/api/client.ts`
- Create: `extension/src/api/client.test.ts`
- Create: `extension/test/fakes/server.ts`
- Create: `extension/test/fakes/server.test.ts`

- [x] define the `ApiClient` interface for every endpoint in the Server API table (incl. password `rotation`), and implement `HttpApiClient(baseUrl, getToken)` with binary vault bodies as `Uint8Array`
- [x] implement `getVault(ifNoneMatch?)` → `ok | not_modified | empty`, and `putVault(body, expected: number | 'none')` → `{version} | {conflict}`
- [x] map errors to typed `ApiError` (`unauthorized`, `invalid_credentials`, `rate_limited` + `retryAfter`, `version_conflict`, `too_large`, `network`, `server`); refuse non-HTTPS server URLs except `localhost`/`127.0.0.1`
- [x] implement `test/fakes/server.ts`: in-memory `ApiClient` with users, devices, versioned vault, 304/412 semantics, retention-free history and rotation
- [x] write tests (mocked `fetch`): method, path, headers and body per endpoint; ETag round trip; 304/404/412 handling; error mapping incl. `Retry-After`; non-HTTPS rejection
- [x] write tests for the fake server's conflict, history and rotation semantics, so later tests rely on correct behavior
- [x] run `npm test` - must pass before Task 20

### Task 20: Applying the merged tree to the browser

**Files:**
- Create: `extension/src/browser/apply.ts`
- Create: `extension/src/browser/apply.test.ts`

- [x] implement `diffTrees(localProjection, merged) → ops`, ordered as folder creates (top-down), bookmark creates, title/url updates, per-folder moves and reorders (minimal moves), then removals bottom-up using `remove` only (no `removeTree`)
- [x] implement `applyOps(adapter, ops, idMap, skipped)`:
  - persist each `idMap` entry, with `nativeUrl` read back from the browser, as soon as its call resolves;
  - a create the browser rejects goes into `skipped`, and the apply continues;
  - `remove` on a non-empty folder → `ConcurrentEditError`;
  - any other failure aborts.
- [x] implement `rebindPending(localNodes, pendingApply, idMap)` for crash recovery (exact match on parent GUID, kind, title, URL), and drop GUIDs from `skipped` once `merged` no longer contains them
- [x] write tests: op ordering (parent before child, removals last); a single reorder needs one move; applying to the Chromium and Firefox fakes, including their URL rewriting and move semantics, yields a projection `treesEqual` to `merged`
- [x] write tests: privileged URL on Firefox → skipped and not seen as a local deletion on the next projection; a folder that gains a child before its removal → `ConcurrentEditError` and the child survives
- [x] write a test for an apply stopped after k ops without throwing (discard in-memory state, rebuild from storage): `rebindPending` + re-projection yields no duplicates
- [x] run `npm test` - must pass before Task 21
- [x] ⚠️ refinement: `diffTrees` became `planOps(local, merged, hasNativeNode, skipped)`.
  - Structure ops (creates and moves) are emitted per folder top-down in merged order. Nodes on the longest increasing subsequence of current positions stay put, so moves are minimal; then updates, then removals bottom-up.
  - `applyOps` resolves anchors at execution time and creates absent roots via `ensureRoot`.
  - A refused URL *update* removes the stale native copy and marks the guid skipped.
  - `pruneSkipped` drops skipped guids that merged no longer has.
  - Projection nodes without a browser node (carried roots) are re-created unless skipped.

### Task 21: Sync engine orchestration, guard and recovery actions

**Files:**
- Create: `extension/src/sync/engine.ts`
- Create: `extension/src/sync/engine.test.ts`
- Create: `extension/src/sync/guard.ts`
- Create: `extension/src/sync/guard.test.ts`
- Create: `extension/src/sync/convergence.property.test.ts`

- [x] implement `syncOnce(deps, {confirmation?})` exactly as in the Sync algorithm (steps 0–9, budget of 3 restarts), returning and persisting `SyncResult` (`ok`, `needs_confirmation`, `conflict_exhausted`, `rollback_detected`, `roots_changed`, `native_sync_detected`, `error`)
- [x] implement `guard.ts`: block when deletions in either direction exceed 25 % of nodes **and** number at least 20; produce `pendingConfirmation = {remoteVersion, deletionsToLocal, deletionsToRemote}`; accept a confirmation only for the same `remoteVersion` and no more deletions than confirmed
- [x] implement recovery actions:
  - `useLocalVersion()` and `acceptServerVersion()` for `rollback_detected`;
  - `rejoin()` for `roots_changed`: re-pin, discard `base`, run `firstSync`.
- [x] write tests:
  - first-device bootstrap and second-device join (no duplicates);
  - local-only change uploads, remote-only change applies;
  - a 304 makes no PUT;
  - 412 retry, then success, and `conflict_exhausted` after 3 restarts.
- [x] write tests:
  - lower `seq` → `rollback_detected`, and both recovery actions;
  - empty vault after a previous sync → `rollback_detected`;
  - the guard blocks in both directions;
  - a confirmation reused against a different remote version asks again;
  - an event-counter change before apply restarts the run and no user edit is lost.
- [x] write tests:
  - `pendingApply` crash recovery;
  - re-login with the same `userId` and an existing `base` uses `merge3`, so deletions made before the revocation are not undone;
  - `roots_changed` → `rejoin` never deletes.
- [x] write the convergence property test:
  - 2–3 simulated devices (Chromium and Firefox fakes with URL rewriting) against one fake server;
  - random interleavings of edits and syncs;
  - after a final round, every projection is `treesEqual` and valid;
  - **settle:** one more round produces zero browser ops and zero PUTs.
- [x] run `npm test` - must pass before Task 22
- [x] ➕ `test/harness.ts` (`World`/`Device`): one fake server plus N simulated browsers with real IndexedDB state.
- [x] ➕ The convergence property was mutation-tested: disabling the projection's URL-rewrite handling makes it fail, shrinking to "one bookmark ending in `#`, two devices". It also passes 300 runs (about 20 user edits per run, up to 22 nodes).
- [x] ➕ Recovery is passed as options to `syncOnce` (`recovery: 'use_local' | 'accept_remote'`, `rejoin`, `confirmation`, `force`) rather than as separate functions. A `roots_changed` state resolves itself when the pinned roots reappear.

### Task 22: Background scheduler and message bus

**Files:**
- Create: `extension/src/background/scheduler.ts`
- Create: `extension/src/background/scheduler.test.ts`
- Create: `extension/src/background/messages.ts`
- Create: `extension/src/background/router.ts`
- Create: `extension/src/background/router.test.ts`
- Modify: `extension/src/background/index.ts`

- [x] implement the scheduler:
  - single-flight sync with a "dirty" re-run flag;
  - listeners only for the events the adapter reports, debounced by 3 s, and counted into the engine's event counter;
  - events during apply mark the scheduler dirty instead of being dropped;
  - Chromium `onImportBegan/onImportEnded` pause syncing.
- [x] create the `poll` alarm (1 min) idempotently (`alarms.get` → create) at top level, in `onInstalled` and in `onStartup`, since alarms may not survive a browser restart; sync on `runtime.onStartup`
- [x] implement backoff and pause state:
  - backoff on network/server errors (30 s → 15 min, jittered) and `Retry-After` are persisted as `nextAttemptAt`, which every alarm checks, because service-worker timers die after ~30 s idle;
  - `unauthorized` → `clearCredentials()` and status `signed_out`;
  - `pause`/`resume` state is persisted.
- [x] define the typed request/response union in `messages.ts`:
  - sync: `getStatus`, `syncNow`, `pauseSync`, `resumeSync`, `confirmPendingSync`, `useLocalVersion`, `acceptServerVersion`, `rejoin`, `acknowledgeNativeSync`;
  - account: `register`, `login`, `logout`, `listDevices`, `revokeDevice`, `changePassword`, `deleteAccount`, `getEmergencyKit`;
  - history: `listVersions`, `restoreVersion`.
- [x] implement `router.ts` as a handler registry: it validates and dispatches. Sync handlers are registered here; account handlers are added in Task 23 and history handlers in Task 26.
- [x] publish status to `storage.session` so the popup and options pages update via `storage.onChanged`
- [x] write tests (fake timers):
  - debounce coalesces bursts;
  - single-flight + dirty re-run;
  - events during apply produce exactly one no-op follow-up;
  - persisted backoff is respected after a simulated service-worker restart;
  - `Retry-After`;
  - 401 keeps `base`, `idMap` and SyncID.
- [x] write tests: the alarm is created once across repeated startups; a Firefox fake without `onChildrenReordered`/`onImport*` starts cleanly; pause/resume; the router rejects unknown and malformed messages and dispatches registered handlers
- [x] run `npm test` - must pass before Task 23
- [x] ➕ 401 handling lives in the engine (it owns the state change). The scheduler restores the previous status when a run did nothing (paused, backoff, no session).
- [x] ➕ `StateStore.lazy()` lets the background register every listener synchronously before IndexedDB has opened, as MV3 requires.
- [x] ➕ `npm run check` (typecheck + lint + tests) gates every commit from here on.

### Task 23: Account flows: register, login, password change, delete

**Files:**
- Create: `extension/src/background/account.ts`
- Create: `extension/src/background/account.test.ts`
- Create: `extension/src/background/emergency-kit.ts`
- Create: `extension/src/background/emergency-kit.test.ts`
- Modify: `extension/src/background/index.ts`

- [ ] implement `register`: prelogin (`assertKdfParams`) → generate SyncID → derive → `createVaultKey` → `POST /register` → persist session (incl. `wrappedVaultKey`), SyncID and key → bootstrap sync; return the SyncID and kit
- [ ] implement `login`: prelogin (`assertKdfParams`) → derive → login (`assertKdfParams` on the response) → unwrap the vault key (failure → `invalid_credentials`) → persist. Resume with `merge3` when `userId` matches the stored one and `base` exists; otherwise clear the old state and join (`firstSync`). The SyncID field is pre-filled after a 401 sign-out.
- [ ] implement `logout` (revoke + `clearAccount`) and `deleteAccount(password)`
- [ ] implement `changePassword(current, next, {rotateKeys})`:
  - plain: `rewrapVaultKey` from the stored wrapped bytes; this device stays signed in;
  - `rotateKeys`: sync first, generate a new SyncID and vault key, encrypt `base` with `seq = lastSeq + 1`, and send it as `rotation`. On 412, sync and retry. Return the new kit.
- [ ] implement `emergency-kit.ts`: plaintext kit with server URL, username, SyncID, creation date and recovery warning, never the password; enforce a 10-character minimum password client-side; register the account handlers with the router
- [ ] write tests (fake server, reduced iterations):
  - register on device 1, then login on device 2, recovers the same vault key;
  - wrong password or wrong SyncID → `invalid_credentials`;
  - a downgraded prelogin is rejected.
- [ ] write tests:
  - plain `changePassword`: old password fails, new one works, other devices revoked, history kept;
  - rotation: the old SyncID fails, a new kit is returned, another device decrypts after re-login, and history holds one version;
  - `deleteAccount` clears local state;
  - the kit contains the SyncID and never the password.
- [ ] run `npm test` - must pass before Task 24

### Task 24: Options page and e2e harness

**Files:**
- Modify: `extension/src/ui/options/options.html`
- Modify: `extension/src/ui/options/options.ts`
- Create: `extension/src/ui/options/options.css`
- Create: `extension/src/ui/shared/rpc.ts`
- Create: `extension/playwright.config.ts`
- Create: `extension/e2e/fixtures.ts`
- Create: `extension/e2e/options.spec.ts`

- [ ] build the server step: validate the URL (HTTPS unless localhost); call `permissions.request` for the origin **synchronously at the top of the click handler, before any `await`**, or Firefox loses the user gesture; then probe `/healthz`
- [ ] build the sign-up form:
  - show the SyncID once;
  - offer "Download emergency kit" (.txt);
  - require the "I saved my SyncID" checkbox before continuing.
- [ ] build the sign-in form: username, password, SyncID with live format validation, pre-filled after a 401 sign-out
- [ ] build the signed-in view:
  - account info and "Show SyncID / download kit";
  - native-sync warning with acknowledgment (Chromium);
  - "Re-pin and rejoin" when roots changed;
  - devices with revoke;
  - change password, with an "a device was lost — rotate keys" option;
  - delete account (type the username to confirm);
  - logout.
- [ ] implement the Playwright fixture: `go build` the server → spawn it on a free port with a temp DB → launch a Chromium persistent context with `dist-e2e/chromium` → resolve the extension id from the service worker URL
- [ ] write e2e tests:
  - registration shows the SyncID and the kit downloads;
  - after logout, sign-in with a wrong SyncID shows an error and the correct one succeeds;
  - the devices list shows the current device, and revoking a device works.
- [ ] write an e2e test: change password with rotation → logout → sign-in needs the new SyncID and the bookmarks are intact
- [ ] run `npm test && npm run e2e` - must pass before Task 25

### Task 25: Toolbar popup: status, sync now, confirmations

**Files:**
- Modify: `extension/src/ui/popup/popup.html`
- Modify: `extension/src/ui/popup/popup.ts`
- Create: `extension/src/ui/popup/popup.css`
- Create: `extension/e2e/popup.spec.ts`

- [ ] render the popup states:
  - signed out (button opening the options page);
  - syncing;
  - ok ("last synced 2 min ago");
  - paused;
  - error with retry;
  - `needs_confirmation` (counts per direction, with Confirm and Pause sync);
  - `rollback_detected` ("Use this browser's bookmarks" / "Accept server version", with an explanation);
  - `native_sync_detected` and `roots_changed` (link to options).
- [ ] add "Sync now" and "Pause/Resume" buttons, with live updates via `storage.onChanged`
- [ ] set the toolbar badge `!` on error or any state needing action; clear it on `ok`
- [ ] write e2e tests: popup shows ok after the sign-in sync; Sync now triggers a sync (server version increments); Pause stops syncing until Resume
- [ ] write an e2e test for mass deletion: seed 40 bookmarks, sync, delete 30 via the service worker → popup asks for confirmation → Confirm applies and the server reflects it
- [ ] run `npm test && npm run e2e` - must pass before Task 26

### Task 26: Version history and restore

**Files:**
- Create: `extension/src/sync/restore.ts`
- Create: `extension/src/sync/restore.test.ts`
- Modify: `extension/src/background/index.ts`
- Modify: `extension/src/ui/options/options.html`
- Modify: `extension/src/ui/options/options.ts`
- Modify: `extension/e2e/options.spec.ts`

- [ ] implement `restoreVersion(v)`:
  - GET and decrypt the **current** vault, then fetch and decrypt version `v`;
  - set `seq = max(current.seq, lastSeq) + 1`;
  - PUT with `If-Match` current, recomputing `seq` on every 412 retry;
  - run `syncOnce` with a confirmation bound to the version it just wrote, so this browser follows; other browsers pick it up through a normal merge.
- [ ] register the history handlers with the router; add an options "History" section (version, date, device, size) with Restore behind a confirmation dialog, noting that versions from before a key rotation are gone
- [ ] write tests:
  - a restoring device at least 2 `seq` behind still writes a `seq` above every device's `lastSeq`;
  - other devices accept it without `rollback_detected`;
  - a concurrent write during restore → 412 → recompute and retry succeeds.
- [ ] write an e2e test: add bookmarks → restore an earlier version → the added bookmarks disappear locally
- [ ] run `npm test && npm run e2e` - must pass before Task 27

### Task 27: Cross-profile end-to-end sync test

**Files:**
- Create: `extension/e2e/sync.spec.ts`
- Modify: `extension/e2e/fixtures.ts`

- [ ] extend the fixture with two Chromium profiles (A, B) on one server, plus helpers to run `chrome.bookmarks.*` in each service worker and to trigger `syncNow`
- [ ] write an e2e test: A registers with existing bookmarks; B, with overlapping bookmarks, signs in → both trees identical, no duplicates
- [ ] write e2e tests:
  - create, rename, move and delete in A show up in B after sync;
  - A deletes a folder while B adds a child → the child survives in the nearest ancestor on both.
- [ ] write an e2e test for real Chromium move semantics: reorder within a folder in A (moves up and down, plus URLs Chrome canonicalizes) → identical order and URLs in B, and one more sync round on each profile uploads nothing
- [ ] write an e2e test for the event-driven path: a bookmark created in A with no manual sync → the server version increments within 10 s
- [ ] write an e2e test for E2EE at rest:
  - stop the server, then confirm a unique seeded title and URL appear in none of `booksync.db`, `booksync.db-wal` or `booksync.db-shm`;
  - the stored vault bytes after `BSV1 ‖ iv` are not a gzip stream (no `1f 8b` prefix).
- [ ] run `npm run e2e` - must pass before Task 28

### Task 28: CI pipeline and release packaging

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `Makefile`
- Modify: `extension/package.json`
- Modify: `extension/scripts/manifest.test.ts`

- [ ] add CI jobs:
  - `go`: gofmt check, `go vet`, golangci-lint, `go test -race ./...`;
  - `extension`: `npm ci`, typecheck, lint, test, build, `web-ext lint`;
  - `e2e`: needs both; Playwright Chromium + the Go toolchain;
  - `docker-smoke`: runs `deploy/smoke.sh`.
- [ ] add `make test` (Go + extension unit tests), `make e2e`, and `make package`, which produces `booksync-chromium-<ver>.zip` and `booksync-firefox-<ver>.zip` (via `web-ext build`)
- [ ] make `package.json` the single source of the extension version; the server version comes from the git tag via `-X main.version`
- [ ] write tests: manifest version stamping and package naming in `manifest.test.ts`
- [ ] run `make test` locally - must pass before Task 29

### Task 29: Verify acceptance criteria
- [ ] verify all eight acceptance criteria from the Overview are implemented, each mapped to at least one automated test (criterion 8 → `docker-smoke`)
- [ ] verify edge cases:
  - separators, privileged URLs, URL canonicalization;
  - the menu folder on Chromium (deleted, rediscovered); account-storage and native-sync roots;
  - rollback after a server backup restore;
  - mass deletion with a stale confirmation;
  - 412 storms;
  - an apply interrupted mid-way;
  - a 401 followed by re-login;
  - key rotation.
- [ ] run the full test suite: `make test`
- [ ] run the e2e tests: `make e2e`
- [ ] verify coverage: `go test -cover ./...` ≥ 80 % for `internal/...`; `npx vitest run --coverage` ≥ 90 % for `src/sync`, `src/crypto` and `src/browser`

### Task 30: [Final] Update documentation
- [ ] write `README.md`:
  - what and why, architecture diagram, security model summary (incl. "lost device → rotate keys");
  - self-hosting with docker compose, plus closing registration and backups (and what to do on `rollback_detected` after restoring one);
  - installing the extension (unpacked builds and stores);
  - development setup and test commands.
- [ ] write `docs/protocol.md`: the Cryptography spec, vault format, Browser mapping rules and Server API as a normative reference for future clients (e.g. a Go CLI or Safari)
- [ ] create `CLAUDE.md`: repo layout, Go and TS conventions, test commands, merge invariants and fake-fidelity rules that must hold
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification**
- Real Firefox via `web-ext run`. Covers what Playwright cannot automate:
  - separators kept in place during reorders, and reorder ping-pong (none expected);
  - the Bookmarks Menu and privileged URLs;
  - URL canonicalization (IDN, percent-encoding) against Chrome;
  - sign-in persisting across a browser restart.
- Edge, Brave, Vivaldi and Opera, loaded unpacked. Watch Opera's Speed Dial and Vivaldi's root quirks.
- Chrome with Google bookmark sync on: confirm sync pauses with `native_sync_detected` and resumes only after acknowledgment.
- Large libraries (10k bookmarks): merge time, vault size, upload latency, service-worker CPU, and the IndexedDB write rate during a full join.
- An MV3 service worker suspended longer than 30 s: remote changes still arrive through the alarm; persisted backoff is honored; offline/online transitions; laptop sleep.

**Security review**
- Independent review of the crypto design: key separation, AAD binding, nonce handling, rollback detection, rotation flow, emergency-kit UX.
- Size Argon2id and the semaphore against the server's RAM; check rate limits behind Caddy.
- `govulncheck ./...`, `npm audit`, and periodic dependency updates.

**External systems and deployment**
- Developer accounts and listings on the Chrome Web Store, Microsoft Edge Add-ons and Firefox AMO, with a privacy policy and AMO data-collection declaration (E2EE simplifies both).
- DNS for `BOOKSYNC_DOMAIN`; Caddy obtains TLS automatically.
- Backups of the SQLite volume (contents are already encrypted), e.g. a scheduled `sqlite3 .backup` or Litestream.
  - Restoring one makes devices report `rollback_detected`.
  - Use "Use this browser's bookmarks" on the most up-to-date device.

**Future iterations**
- A push channel (SSE/WebSocket) for instant propagation; Safari Web Extension; separators, tags and keywords; an Argon2id client KDF through WASM (KDF params are already versioned).
- A per-record vault model if libraries outgrow snapshots; an admin CLI (list or disable users, invite-only registration, per-user quotas); optional PostgreSQL backend.
