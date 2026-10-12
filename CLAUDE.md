# BookSync: notes for contributors and coding agents

BookSync is end-to-end encrypted bookmark sync. A Go server (`cmd/`, `internal/`,
`deploy/`) stores encrypted vault snapshots. A TypeScript MV3 WebExtension
(`extension/`), built for Chromium and Firefox, does all crypto and merging.

- [README.md](README.md) covers what the project is and how to self-host it.
- [docs/protocol.md](docs/protocol.md) is the normative spec. Update it together with
  any change to crypto, the vault format, the API or the sync rules.
- `docs/plans/completed/` holds the original implementation plan and its deviation notes.

## Commands

| Task | Command |
|---|---|
| Everything a commit must pass | `make test` (Go `-race`, then `npm run check` in `extension/`) |
| Go lint | `make lint` (golangci-lint **v2.14+ built with Go 1.27**; set `GOLANGCI_LINT=…` if it's not on `PATH`) |
| Go format | `make fmt`; CI fails on unformatted files |
| Extension only | `cd extension && npm run check` (tsc, eslint, vitest) |
| e2e (real Chromium + real server) | `make e2e` (uses `CHROMIUM_PATH`, `/opt/pw-browsers/chromium`, or Playwright's download) |
| Container smoke test | `make docker-smoke` (`SMOKE_BUILD=0` reuses a prebuilt image) |
| Longer property runs | `cd extension && FC_RUNS=3000 npx vitest run src/sync` |
| Coverage | `go test -cover ./internal/...` (keep ≥ 80 %); `npx vitest run --coverage` (keep ≥ 90 % statements for `src/sync`, `src/crypto`, `src/browser`) |

- Run `npm run check` (or `make test`) before every commit. A lint error must never
  land.
- `go.mod` has `ignore ./extension`, because `node_modules` contains a Go package.
  Keep it.

## Go conventions (server)

- **Layout.** `cmd/booksync-server` holds `main`, plus the `healthcheck` subcommand used
  by the distroless image. `internal/config` reads env vars into one struct.
  `internal/store` is SQLite; `internal/auth` is Argon2id and tokens; `internal/api`
  holds the HTTP handlers.
- **Dependencies.**
  - The stdlib covers HTTP (`net/http`, Go 1.22+ pattern routes), `log/slog` and
    `database/sql`.
  - Beyond the stdlib, only `modernc.org/sqlite` (CGO-free), `golang.org/x/crypto` and
    `golang.org/x/time/rate`.
  - The binary must build with `CGO_ENABLED=0`.
- **Errors.**
  - Every error response goes through `writeError(w, status, code, message)` as
    `{"error":{"code","message"}}`.
  - Clients branch on `code`. Codes are API surface: don't rename them.
  - Unexpected errors go through `s.internalError`, which logs and returns `500 internal`.
- **Requests.**
  - Decode JSON with `decodeJSON`: it applies the 64 KiB cap (`413`) and rejects
    unknown fields and trailing data (`400`).
  - Binary JSON fields use the `b64` type (unpadded base64url).
- **SQLite.**
  - Per-connection pragmas live in the DSN, not in `Exec` calls.
  - Writes use `withTx`. The DSN's `_txlock=immediate` serializes writers, which makes
    `PutVault`'s compare-and-insert race-free.
  - Migrations are embedded and numbered (`migrations/000N_*.sql`). Add a new file;
    never edit an applied one.
- **Secrets.**
  - Tokens are stored as SHA-256 hashes.
  - `authKey` is stored as `paramSetID ‖ Argon2id`. New Argon2 parameters get a new id;
    old hashes must keep verifying.
  - A failed login for an unknown user runs `DummyVerify`, so timing doesn't reveal
    which accounts exist.
- **Tests.**
  - Table-driven with stdlib `testing` and `httptest`.
  - Use a real SQLite database in `t.TempDir()`; there are no store mocks.
  - Use `auth.NewTestHasher()`: cheap parameters, under an id production rejects.
  - `gosec` and `noctx` are excluded for `_test.go` in `.golangci.yml`.

## TypeScript conventions (extension)

- **Language and dependencies.**
  - Strict TypeScript 6.0. typescript-eslint doesn't support TS 7 yet.
  - **No runtime dependencies.** Only WebCrypto, `CompressionStream` and IndexedDB.
- **Browser APIs.**
  - Access them only through `ext()` (`src/platform/ext.ts`), never through a global
    `chrome` or `browser`. Tests install fakes there.
  - Build-time flags: `__BOOKSYNC_TARGET__` (`chromium`/`firefox`) and `__BOOKSYNC_E2E__`.
- **The background is an MV3 service worker.**
  - Register every listener synchronously, in the first turn of the event loop. That is
    why `StateStore.lazy()` exists.
  - No timer may be relied on across worker restarts. Backoff is persisted as
    `nextAttemptAt`, and a 1-minute alarm polls.
- **UI ↔ background** goes through typed messages: `background/messages.ts` (the
  `Protocol` map) and `router.ts`. UI pages call `send(type, req)` from
  `ui/shared/rpc.ts`.
- **Tests.**
  - Unit tests sit next to the code (`*.test.ts`).
  - Shared helpers live in `extension/test/`:
    - `builders.ts`: `doc()` and `outline()` for compact trees;
    - `fakes/bookmarks.ts`;
    - `fakes/server.ts`;
    - `harness.ts`: `World` and `Device`, for N browsers against one fake server with
      real IndexedDB state through `fake-indexeddb`.

## Invariants that must hold

Breaking any of these causes data loss, duplication or ping-pong between browsers. The
property tests (`merge.property.test.ts`, the property block in `first-sync.test.ts`,
`convergence.property.test.ts`) guard most of them. When changing sync code, run them
with a higher `FC_RUNS`.

**Merge (`src/sync/merge.ts`, `first-sync.ts`)**

- `merge3` is deterministic and its output always passes `validateTree`. Every device
  must compute the same result from the same inputs.
- Roots are never added, deleted, moved or renamed.
- Edit beats delete. On a true conflict (title, URL or parent changed differently on
  both sides), remote wins. A change in child order alone is not an edit.
- Orphans of a deleted folder go to the nearest surviving ancestor, else `unfiled_____`.
  A cycle resolves to the remote parent, else `unfiled_____`.
- `firstSync` never deletes or renames anything that is on the server. GUID matches
  come before content matches. Each remote node is matched at most once.
- Once converged, a run makes **zero browser writes and zero uploads**.

**Projection and apply (`src/browser/`)**

- Native indices are never trusted across calls. Every write is positioned by anchor
  (`create(parent, afterId)`, `moveAfter`), resolved against the folder's children at
  write time.
- A root the browser can't show (Chromium menu folder deleted, Mobile hidden while
  empty, a root Firefox lacks) is carried from `base`. Skipped nodes are re-inserted
  from `base`. Neither may ever read as a local deletion.
- A browser-canonicalized URL reads back as the vault URL while it still equals the
  stored `nativeUrl`.
- Before the first browser write, persist `pendingApply`. Persist each id-map entry as
  soon as its browser call returns. `rebindPending` must be able to recover from a crash
  at any point without duplicating anything.
- Remove folders only bottom-up with `remove`, never `removeTree`. A `NonEmptyFolderError`
  means the user added something meanwhile: restart, don't force.
- Skipped GUIDs are retried on every apply and pruned once `merged` drops them.

**Engine (`src/sync/engine.ts`)**

- `base`, `version` and `lastSeq` advance only after the apply **and** the upload
  succeed.
- A 401 clears only the device token and the vault key. `base`, the id map and the
  SyncID stay, so re-login resumes `merge3`.
- `seq` only grows. A server vault with `seq < lastSeq`, or an emptied vault while
  `base` exists, is `rollback_detected`. Never resolve it automatically.
- A mass-deletion confirmation is bound to `remoteVersion` and to the confirmed
  deletion counts.

**Crypto (`src/crypto/`)**

- Never change derivation inputs, `info` or AAD strings, the envelope magic or the
  SyncID format. Doing so locks every existing user out. A change means a new
  version (`booksync/v2…`, `BSV2`) plus a migration.
- The client enforces `kdf == "pbkdf2-sha256"` and `iterations ≥ 600000` on anything the
  server sends.
- The keys test vector in `keys.test.ts` was computed independently. Don't regenerate it
  from the code under test.

## Fake fidelity

`test/fakes/bookmarks.ts` stands in for both browsers in unit tests, and Firefox is
verified almost entirely through it. A behavior the fake gets wrong is a bug that
ships. It must keep reproducing:

- **Moves.** Chromium's same-parent `move` index counts positions *before* removing the
  node. Firefox's index is the final position.
- **URL canonicalization on save.** The browsers differ: this Firefox fake drops an empty
  trailing `#`, Chromium keeps it.
- **`remove()`** rejects non-empty folders.
- **Firefox:**
  - separators exist;
  - privileged URL schemes (`javascript:`, `data:`, `file:`, `chrome:`, `about:` …) are
    rejected with an error mentioning the URL.
- **Chromium:**
  - Mobile bookmarks (id `3`) is hidden from `getTree` and unwritable while empty;
  - there may be a managed (read-only) folder;
  - Chromium 134+ may have account-storage roots with `syncing: true`;
  - legacy versions lack `folderType`.
- **Events.** Each browser fires its own event set; Firefox has no import or
  children-reordered events.

When a real-browser test (e2e or manual) disagrees with the fake:

1. fix the fake;
2. add a unit test that reproduces the real behavior;
3. then fix the code.

Keep the property tests passing against the corrected fake. This is how the hidden
Mobile folder and four apply bugs were found.
