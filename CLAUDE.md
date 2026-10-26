# BookSync: notes for contributors and coding agents

BookSync is end-to-end encrypted bookmark sync. A Go server (`cmd/`, `internal/`,
`deploy/`) stores encrypted vault snapshots. A TypeScript MV3 WebExtension
(`extension/`), built for Chromium and Firefox, does all crypto and merging, and is the
reference client. The Android app uses three pieces:

- `internal/client/`, a Go port of the client core;
- `mobile/`, its gomobile facade;
- `android/`, a Kotlin + Compose app. It is its own bookmark store, because Android
  browsers don't expose their bookmarks.

- [README.md](README.md) covers what the project is and how to self-host it.
- [docs/protocol.md](docs/protocol.md) is the normative spec. Update it together with
  any change to crypto, the vault format, the API or the sync rules.
- [SECURITY.md](SECURITY.md) is the vulnerability-reporting policy. Keep its scope and
  "Not vulnerabilities" list in step with the README's Security model.
- `docs/plans/completed/` holds the original implementation plan and its deviation notes.

## Commands

| Task | Command |
|---|---|
| Everything a commit must pass | `make test` (Go `-race` for both Go modules, then `npm run check` in `extension/`) |
| Go lint | `make lint` (golangci-lint **v2.14+ built with Go 1.27**, for the root and `mobile/`; set `GOLANGCI_LINT=…` if it's not on `PATH`) |
| Go format | `make fmt`; CI fails on unformatted files |
| Extension only | `cd extension && npm run check` (tsc, eslint, vitest) |
| e2e (real Chromium + real server) | `make e2e` (uses `CHROMIUM_PATH`, `/opt/pw-browsers/chromium`, or Playwright's full Chromium via `channel: 'chromium'`; never its headless shell, which can't load extensions) |
| e2e in Microsoft Edge | `make e2e-edge` (`BOOKSYNC_E2E_BROWSER=msedge`; needs Edge stable installed, e.g. `npx playwright install msedge`). Edge names the roots "Favorites bar" / "Other favorites": use `ROOTS` from `e2e/fixtures.ts`, never hardcoded root titles |
| Container smoke test | `make docker-smoke` (`SMOKE_BUILD=0` reuses a prebuilt image) |
| All release artifacts | `make dist` (`VERSION=X.Y.Z` stamps the server and the extension); pushing a `vX.Y.Z` tag, or creating a release in the GitHub UI, runs `.github/workflows/release.yml` |
| Longer property runs | `cd extension && FC_RUNS=3000 npx vitest run src/sync` |
| Go client properties | `BOOKSYNC_PROP_RUNS=3000 go test ./internal/client/merge ./internal/client/engine` |
| Golden corpus | `cd extension && npm run conformance:gen` (`CONFORMANCE_ENVELOPES=1` also rewrites `envelope.json`); `cd internal/client/crypto && go test -run TestGoFixtures -update` rewrites the Go → TS fixtures |
| Android | `make android-aar` (the Go core AAR; needs the SDK and NDK r29), then `make android-test` (buildSrc tests, JVM unit and Robolectric UI tests, lint) or `make android-apk` |
| Kotlin fixtures | `cd mobile && go test -run TestKotlinFixtures -update` (Kotlin model tests decode them) |
| Coverage | `go test -cover ./internal/...` (keep ≥ 80 %); `npx vitest run --coverage` (keep ≥ 90 % statements for `src/sync`, `src/crypto`, `src/browser`, `src/bookmarks`) |

- Run `npm run check` (or `make test`) before every commit. A lint error must never
  land.
- `go.mod` has `ignore ./extension`, because `node_modules` contains a Go package.
  Keep it.
- `mobile/` is a **nested module** (`replace … => ../`). That keeps `golang.org/x/mobile`,
  and gomobile and gobind (pinned as `tool` directives), out of the root `go.mod`. Root
  `./...` skips it; `make test`, `lint`, `fmt` and CI cover it explicitly.
- The release workflow calls `ci.yml` through `workflow_call`. A job added to CI
  therefore also gates releases.
- Store submissions are the release's last job (`stores` environment, approved by a
  person) running `scripts/publish-stores.sh`. It is plain bash with curl, jq and
  openssl, so no third-party action sees the store keys. Keep it `shellcheck`-clean,
  and keep docs/store-publishing.md in step with it.
- Release versions come from the tag. The extension gets `X.Y.Z` through
  `BOOKSYNC_VERSION` (`extensionVersion()` in `scripts/manifest.mjs`). `package.json`'s
  version only covers builds that aren't from a tag.

## Go conventions (server)

- **Layout.** `cmd/booksync-server` holds `main`, plus the `healthcheck` subcommand used
  by the distroless image. `internal/config` reads env vars into one struct.
  `internal/store` is SQLite; `internal/auth` is Argon2id and tokens; `internal/api`
  holds the HTTP handlers.
- **Home page (`GET /`, `internal/api/home.*`).** Rendered by `html/template` from the
  same `serverInfo` as `GET /v1/info`.
  - No JavaScript. The CSP is `default-src 'none'` plus a `style-src` hash.
  - CSS lives only in `home.css`. It is hashed at init and inserted as `template.CSS`.
    Never put CSS in `home.html`: `html/template` rewrites literal `<style>` text, so the
    hash would stop matching. No inline `style=` attributes either.
  - Keep its endpoint table (`homeEndpoints`) in step with `docs/protocol.md` §3.2.
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
  - Firefox for Android has no bookmarks API. The background and every page check
    `hasBookmarksApi()` first and show `unsupportedNotice()` instead of starting; a
    new page must do the same.
- **The background is an MV3 service worker.**
  - Register every listener synchronously, in the first turn of the event loop. That is
    why `StateStore.lazy()` exists.
  - No timer may be relied on across worker restarts. Backoff is persisted as
    `nextAttemptAt`, and a 1-minute alarm polls.
- **Bookmark UI (popup search, "Bookmark this page", the manager).**
  - All logic lives in `src/bookmarks/` (pure and unit-tested): tree helpers, search,
    selection, drop rules, edit operations and the refresh gate.
  - `src/ui/**` stays thin and is covered by Playwright, since vitest runs in Node and
    excludes `src/ui` from coverage.
  - UI pages edit bookmarks only through `src/bookmarks/ops.ts`, never with raw
    `bookmarks.move` indices. `ops.ts` locks the roots, the Chromium menu folder
    included.
  - Pages get their roots from the background (`bookmarkRoots`) on every load.
  - Anything that edits holds the refresh gate, so a live refresh never destroys an
    inline rename, a dialog or a drag.
  - Popup status re-renders must stay inside `#status-app`.
- **Probing a server** from a UI page goes through `checkServer` / `serverOrigin`
  (`src/api/server-check.ts`); its wording comes from `describeServerCheck`, so it is
  unit-tested. Host permissions are requested synchronously in the click: Firefox drops
  the user gesture after an `await`.
- **UI ↔ background** goes through typed messages: `background/messages.ts` (the
  `Protocol` map) and `router.ts`. UI pages call `send(type, req)` from
  `ui/shared/rpc.ts`.
- **Tests.**
  - Unit tests sit next to the code (`*.test.ts`).
  - e2e: the fixtures wait until a service worker exposes `chrome.bookmarks`. Playwright
    reports the worker before Chromium installs the extension APIs in it.
  - Shared helpers live in `extension/test/`:
    - `builders.ts`: `doc()` and `outline()` for compact trees;
    - `fakes/bookmarks.ts`;
    - `fakes/server.ts`;
    - `harness.ts`: `World` and `Device`, for N browsers against one fake server with
      real IndexedDB state through `fake-indexeddb`;
    - `bookmark-trees.ts`: a fake browser plus the real adapter, for `src/bookmarks`
      tests.

## Go client core (`internal/client`, `mobile/`)

- **Packages.**
  - `crypto`, `vault`, `merge`: function-by-function ports of the extension's
    `src/crypto`, `src/model/vault.ts`, `merge.ts` and `guard.ts`.
  - `api`: the HTTP client, with `toApiError`'s mapping.
  - `store`: sealed state (AES-GCM under a data key wrapped by a platform `KeyWrapper`).
  - `ops`: tree edits with `ops.ts`'s rules.
  - `engine`: the session and the sync run.
  - `testserver`: the real `internal/api` over a temp SQLite, plus a fault-injecting
    `RoundTripper`.
- **Dependencies.** Stdlib only (`crypto/pbkdf2`, `crypto/hkdf`, …); no new modules in the
  root `go.mod`. Go has no NFC normalization, so callers pass NFC passwords (Kotlin
  normalizes).
- **Parity is the corpus.** When TS code in `src/crypto`, `src/model`, `src/sync/merge.ts`
  or `guard.ts` changes:
  1. regenerate `testdata/conformance` (`npm run conformance:gen`);
  2. make the Go replay pass;
  3. commit both.

  Never hand-edit corpus files.
- **JSON.** Use `vault.Parse` and `vault.Marshal`, never plain `encoding/json`, on vault
  documents. They follow the presence rules in protocol §2 ("Encoding"). One Go upload
  with `children: null` would make every extension refuse the vault.
- **Ordering.** Sort GUIDs with `vault.SortGUIDs` / `CompareGUID` (UTF-16 order, like JS
  `.sort()`), never `sort.Strings`.
- **Engine locks.** `mu` guards state for short sections and is never held across HTTP;
  `runMu.TryLock` makes `Sync` single-flight (`busy`).
- **Facade.** `mobile/` uses bindable types only. Errors cross as `{code, message}` JSON;
  everything else crosses as JSON strings. Its Go tests write the Kotlin fixtures in
  `android/app/src/test/resources/fixtures` and fail on drift.
- **Tests.**
  - Run against `testserver`, never mocks.
  - Registration and login run real PBKDF2 at 600k iterations, which the server enforces,
    so engine tests use `t.Parallel()`.

## Android app (`android/`)

- **Toolchain.** AGP 9 with built-in Kotlin; compileSdk and targetSdk 37, minSdk 26. Lint
  runs with `warningsAsErrors`: a lint finding must never land. The "newer version
  available" checks are disabled: they turn red on an upstream release with no change
  here, and once failed the v1.0.0 release gate. Upgrade Gradle with
  `./gradlew wrapper --gradle-version X`, never by editing the properties file.
- **Versioning.** `android/buildSrc` derives `versionName`/`versionCode` from
  `BOOKSYNC_VERSION` (rc-aware); it has its own tests.
- **Talking to the core.** UI code uses the `BookSyncCore` interface, never the AAR
  classes. `GoCore` is the only implementation; `FakeCore` (test sources) backs the JVM
  tests, because the native library can't load under Robolectric.
- **One core per process.** `BookSyncApplication` (`CoreProvider`) owns the core and the
  `SyncController`; activities and the share worker reuse them.
- **Sync** runs only in the foreground (`ProcessLifecycleOwner`), plus one WorkManager
  job after a share. `Blocked` states (rollback, mass deletion, re-auth) stop automatic
  syncs until the user answers. Never resolve them in code.
- **Search** is a Kotlin port of `search.ts` (NFKD, `decodeURI`); keep it in step with
  the TS tests ported to `BookmarkSearchTest`.
- **Secrets.** Login, register and the emergency kit use `SecureScreen()` (`FLAG_SECURE`).
  Backups are off (`allowBackup=false` plus data-extraction rules).
- **Network in restricted environments.** If Maven Central rate-limits:
  - run Gradle with an init script that puts Google's Central mirror first;
  - set `ROBOLECTRIC_REPO_URL` for Robolectric's runtime downloads.

  CI needs neither.

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

**App-as-store engine (`internal/client/engine`)**

- One atomic commit after the upload: `local = merged`, `base`, `version` and
  `lastSeq`, only if `localRev` is unchanged. On a mismatch, write nothing and restart.
  An edit made during a run is never lost.
- A first sync (no `base`) adopts the remote and requires an empty local tree
  (`local_not_empty` otherwise). It never merges an unknown local tree into an account.
- After a 401, only the device token and the vault key go. Re-login is allowed only into
  the same account (server, username and `userId`).

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
