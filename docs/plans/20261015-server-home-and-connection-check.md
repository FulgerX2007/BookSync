# Server home page and connection check

## Overview
- **Server home page.** `GET /` on the BookSync server serves a polished
  service-info page, in the spirit of the xBrowserSync API page
  (https://xbsapi.conect.md/). It shows:
  - live status (storage reachable or not), server version and whether sign-up is open;
  - how to connect the extension;
  - a short API reference.

  Today `GET /` returns a JSON `404`.
- **Machine-readable info.** A new `GET /v1/info` endpoint returns the same facts as
  JSON. The extension uses it to check a server.
- **Connection check in the extension.**
  - The connect step gets a **Test connection** button with an inline green/red result.
  - When signed in, a **Server** card in Settings shows whether the server is reachable,
    with a **Check now** button.

## Context (from discovery)
- **Server.**
  - `internal/api/server.go` registers routes on a Go 1.22 pattern mux.
  - `dispatch` turns unmatched routes into a JSON `404`, and `handleHealth` pings the
    store.
  - `cmd/booksync-server/main.go` holds `var version` (set with `-ldflags`). It is not
    passed to `api` today.
- **Extension.**
  - `src/ui/options/options.ts`: `renderSignedOut` / `onConnect`. The host permission is
    requested synchronously in the click (Firefox drops the user gesture after an
    `await`), then the page fetches `/healthz`. `registerForm` is in the same file.
  - `src/api/client.ts` is the typed API client.
- **Tests.**
  - Go: table-driven, `httptest`, real SQLite in `t.TempDir()`
    (`internal/api/*_test.go`, `helpers_test.go`).
  - Extension: vitest next to the code. `e2e/options.spec.ts` drives the options page in
    real Chromium/Edge.
- **Docs.** `docs/protocol.md` §3.2 is the normative endpoint table. README covers
  self-hosting.
- **Constraints chosen.**
  - No external assets: inline CSS, system fonts, an inline SVG icon, a strict CSP.
  - Light and dark theme via `prefers-color-scheme`.
  - The version is shown publicly.
  - No new Go or npm dependencies.

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
- run tests after each change (`make test`; `make lint` for Go)
- maintain backward compatibility. The extension must still connect to a server
  without `/v1/info`, falling back to `/healthz`.

## Testing Strategy
- **unit tests**:
  - Go: table-driven `httptest` tests for `/v1/info` and `GET /`.
  - vitest: `checkServer` and `describeServerCheck`, pure, with an injected `fetch`.
- **e2e tests**: Playwright in `e2e/options.spec.ts`, run in Chromium (`make e2e`) and
  Edge (`make e2e-edge`). UI changes get their e2e tests in the same task.
- Coverage stays ≥ 80 % for `internal/...`.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope
- keep plan in sync with actual work done

## Solution Overview
- **Rendered by the server (approach A).**
  - `GET /{$}` executes an embedded `html/template` per request, filled with the same
    `serverInfo` struct that `/v1/info` serializes.
  - There is no JavaScript, so the CSP can say `script-src 'none'`.
  - The status is never stale, and everything stays stdlib-only.
- **One source of truth.** `func (s *Server) info(ctx) serverInfo` computes:
  - status, from `Store.Ping` with a 2 s timeout, like `handleHealth`;
  - version, registration open, max vault bytes and the protocol version.

  Both handlers use it.
- **Extension check.**
  - A pure `checkServer(url, fetch)` in `src/api/server-check.ts` returns a
    discriminated result.
  - The options page calls it from the Test button, from Continue and from the signed-in
    Server card.
  - It needs no background message: the page already fetches `/healthz` directly, and
    the host permission is granted to the extension origin.

## Technical Details
- **`GET /v1/info`.** No auth, not rate-limited (like `/healthz`), always `200`.

  ```json
  {
    "service": "booksync",
    "protocol": 1,
    "version": "0.2.0",
    "status": "ok",
    "registrationOpen": true,
    "maxVaultBytes": 10485760
  }
  ```

  - `status` is `"ok"` or `"unavailable"` (when the store ping fails). A failed ping is
    logged as in `handleHealth`.
  - `registrationOpen` is `cfg.AllowRegistration`.
  - `protocol` is the major version from protocol.md's title ("v1"). Clients must ignore
    unknown fields.
- **`GET /` (and `HEAD /`).** `text/html; charset=utf-8`, status 200, even when the
  status is `unavailable`: the page reports it. Headers:
  - `Content-Security-Policy: default-src 'none'; style-src 'sha256-<hash>'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
    - The CSS lives in its own embedded `internal/api/home.css`. It is hashed once at
      init, from exactly those bytes, and inserted as `<style>{{.CSS}}</style>` with
      `.CSS` typed `template.CSS`, which is emitted verbatim.
    - Hashing the `<style>` block of `home.html` would not work: `html/template`
      rewrites literal text (it strips HTML comments and blanks CSS `/* */` comments),
      so the served bytes would differ from the hashed ones and the browser would
      block the CSS.
    - No inline `style="…"` attributes anywhere, the SVG included: a hash in
      `style-src` does not allow them without `'unsafe-hashes'`.
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
    `Cache-Control: no-store`.
  - `/{$}` matches only the root. Every other unknown path keeps its JSON `404`, and
    `POST /` gets a JSON `405` with `Allow: GET, HEAD` through the existing `dispatch`.
    The handler has no HEAD branch: `net/http` drops the body itself.
  - `GET /` is the API's one non-JSON success response.
- **Page sections.**
  - Header: inline SVG logo, "BookSync", tagline "End-to-end encrypted bookmark sync".
  - Status panel: a pill (green "Online" / red "Storage unavailable"), version, sign-up
    open or closed, maximum vault size (human-readable).
  - "Connect your browser": the three steps, and this server's address to paste.
    - The address comes from `r.Host` and the scheme: `https` when `r.TLS != nil`, or
      the **first** `X-Forwarded-Proto` entry, but only when
      `BOOKSYNC_TRUST_PROXY_HEADERS` (Caddy and DSM set a single value).
    - It is HTML-escaped by `html/template`.
    - A note under it reads "If this server is behind a path prefix, include it".
      Protocol §3.1 allows prefixes, and `r.Host` can't see them. No new config.
    - When the scheme is `http` and the host is not `localhost`/`127.0.0.1`, a warning
      reads "The extension requires HTTPS", since `normalizeServerUrl` would reject
      the address with `insecure_url`.
  - "Privacy": the server stores only ciphertext and Argon2id hashes; the SyncID never
    leaves your browsers.
  - API reference: a table of the §3.2 endpoints (method badge, path, auth, purpose).
  - Footer: link to the GitHub repo and releases.
- **Version plumbing.** `api.Deps.Version string`, set by `main.go` from `version`. It
  defaults to `"dev"` when empty.
- **Extension `checkServer` result.**

  ```ts
  type ServerCheck =
    | { ok: true; version: string | null; registrationOpen: boolean | null; maxVaultBytes: number | null }
    | { ok: false; reason: 'unreachable' | 'not_booksync' | 'storage_unavailable' | 'timeout' };
  ```

  - **Signature:** `checkServer(baseUrl, { fetchFn, timeoutMs = 8000 })`. It reuses the
    exported `FetchFn` type and the default-fetch style of `src/api/client.ts`.
  - **Flow:** `GET /v1/info` with `AbortSignal.timeout(timeoutMs)`. Results are mapped
    in this order:
    1. a network error → `unreachable`;
    2. a `TimeoutError` → `timeout`;
    3. 404 → fall back to `GET /healthz` (an older server):
       - 2xx → `ok`, with `null` facts;
       - 503 → `storage_unavailable`;
       - anything else → `unreachable`;
    4. any other non-2xx (for example 502/503/504 HTML from a reverse proxy whose
       backend is down, or a 401/403 from an auth wall) → `unreachable`, never
       `not_booksync`;
    5. 2xx with unparseable JSON or `service !== "booksync"` → `not_booksync`;
    6. `status: "unavailable"` → `storage_unavailable`;
    7. otherwise → `ok`.
  - **Shared origin helper.** The origin pattern for the permission
    (`${protocol}//${hostname}/*`) moves into one helper, `serverOrigin(url)`, which the
    connect step and the Server card both use.
- **Options UI.**
  - **Connect card.** A **Test connection** button next to **Continue**. Both request
    the permission synchronously in the click, then run `checkServer`. The result
    renders into `#connect-check`:
    - success, e.g. "Connected to BookSync 0.2.0 · sign-up open";
    - failure, a red line with a short cause and hint.

    Continue proceeds only on `ok`. When `registrationOpen === false`, the auth step
    opens on **Sign in** and the Create account tab shows "Sign-up is closed on this
    server."
  - **Signed-in Server card.** It shows the server address, a dot plus text ("Reachable
    · BookSync 0.2.0" / "Not reachable: …") and "checked HH:MM", with a **Check now**
    button. Nothing is persisted.
    - **State.** Module-level `let serverCheck: { result: ServerCheck; at: number } |
      null` plus an in-flight flag. `renderSignedIn()` always draws the card from
      that state, so `onStatus` → `render()` rebuilds never blank it.
    - **When it runs.** The check fires on the first signed-in render of the page and
      on **Check now**. When it finishes, it updates only `#server-card`. The state is
      cleared on sign-out or a server change.
    - **Permission.** Before checking, call `ext().permissions.contains({ origins:
      [serverOrigin(url)] })`. If the user revoked the permission, show "Permission
      missing", and **Check now** re-requests it synchronously in the click, instead of
      a misleading "Not reachable".

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): code, tests and docs in this repo.
- **Post-Completion** (no checkboxes): visual review in real browsers, checking behind a
  reverse proxy.

## Implementation Steps

### Task 1: Server info model and `GET /v1/info`

**Files:**
- Create: `internal/api/info.go`
- Create: `internal/api/info_test.go`
- Modify: `internal/api/server.go` (`Deps.Version`, route)
- Modify: `cmd/booksync-server/main.go` (pass `version`)
- Modify: `internal/api/helpers_test.go` (let a test set `Deps`, e.g. `Version`)

- [ ] add `Version string` to `api.Deps`, defaulting to `"dev"` in `NewServer`, and set it in `main.go`
- [ ] create `serverInfo` and `(s *Server) info(ctx)`, sharing the store ping with `handleHealth` (extract a small `storageOK(ctx)` helper so both use it)
- [ ] register `GET /v1/info` → `handleInfo`, writing JSON with `writeJSON`
- [ ] extend `newTestEnv` with a deps option (or build `NewServer` directly in that case) so tests can set `Deps.Version`
- [ ] write table-driven tests: ok; registration closed; `maxVaultBytes` from config; version from `Deps`; `"dev"` default
- [ ] write tests for the error path: store closed → `200` with `status: "unavailable"`; `POST /v1/info` → JSON `405`
- [ ] extend `deploy/smoke.sh`: `/v1/info` through Caddy returns `"service":"booksync"`
- [ ] run `make test`, `make lint` and `make docker-smoke` - must pass before next task

### Task 2: Server-rendered home page

**Files:**
- Create: `internal/api/home.go`
- Create: `internal/api/home.html` (embedded with `//go:embed`)
- Create: `internal/api/home.css` (embedded; hashed for the CSP)
- Create: `internal/api/home_test.go`
- Modify: `internal/api/server.go` (route `GET /{$}`)

- [ ] write `home.css` and `home.html`:
  - CSS variables for light/dark (`prefers-color-scheme`), system font stack, an inline SVG logo and a data URI favicon, with no `style=` attributes anywhere;
  - responsive single column below 640 px, no horizontal scroll;
  - the sections from Technical Details.
- [ ] parse the template once at init (`template.Must`); hash `home.css` (SHA-256, base64) for the CSP and pass it to the template as `template.CSS`
- [ ] `handleHome`: build the view from `s.info(ctx)` plus the derived server URL (first `X-Forwarded-Proto` entry, trusted only), the path-prefix note and the HTTPS warning; set the security headers; render with `200`. No HEAD branch.
- [ ] keep the API reference rows as a Go slice in `home.go`, so the template ranges over data, not hand-written HTML
- [ ] write tests:
  - `GET /` → 200, `text/html`, CSP with `script-src`-free `default-src 'none'`, status pill text, version, "sign-up open/closed";
  - `HEAD /` → 200 with no body, through `httptest.NewServer` and a real client (`ResponseRecorder` keeps HEAD bodies);
  - the CSP style hash matches the bytes of the served `<style>` block;
  - the served HTML has no `style=` attribute.
- [ ] write tests for edge cases:
  - store down → page shows "Storage unavailable";
  - `GET /nope` → still JSON `404`; `POST /` → JSON `405` with `Allow: GET, HEAD`;
  - an `http://` non-local host shows the HTTPS warning, and `localhost` doesn't;
  - `X-Forwarded-Proto: https, http` with trusted headers → `https`;
  - a `Host` header with `<script>` is escaped;
  - `X-Forwarded-Proto: https` is ignored unless proxy headers are trusted.
- [ ] extend `deploy/smoke.sh`: `GET /` through Caddy returns `text/html` with the status pill
- [ ] run `make test`, `make lint`, `go test -cover ./internal/...` (≥ 80 %) and `make docker-smoke` - must pass before next task

### Task 3: `checkServer` in the extension

**Files:**
- Create: `extension/src/api/server-check.ts`
- Create: `extension/src/api/server-check.test.ts`
- Modify: `extension/src/api/client.ts` (export `FetchFn`)

- [ ] export `FetchFn` from `src/api/client.ts` if not already exported
- [ ] implement `checkServer(baseUrl, { fetchFn, timeoutMs })` with the status mapping from Technical Details, plus `serverOrigin(url)`
- [ ] export `describeServerCheck(check)` → `{ tone: 'ok' | 'bad'; text: string }` for the UI, so the wording is unit-tested rather than living in `src/ui`
- [ ] write tests for the success cases: full info; older server (404 → healthz 200); sign-up closed
- [ ] write tests for the error cases:
  - network error;
  - a real timeout: a fetch that waits on `init.signal`, with `timeoutMs: 10`;
  - non-JSON 200; `service` mismatch; `status: "unavailable"`;
  - 502 with an HTML body → `unreachable`; 401 → `unreachable`;
  - healthz 503 → `storage_unavailable`; healthz 500 → `unreachable`.
- [ ] write a table test for `describeServerCheck`: every `reason`, an old server's null facts, sign-up open and closed
- [ ] run `cd extension && npm run check` - must pass before next task

### Task 4: Test connection on the connect step

**Files:**
- Modify: `extension/src/ui/options/options.ts`
- Modify: `extension/src/ui/options/options.css` (status line styles, if not already shared)
- Modify: `extension/e2e/options.spec.ts`
- Modify: `extension/e2e/fixtures.ts` (`startServer(env)`)

- [ ] change `startServer(env: Record<string, string> = {})` to merge `env` into the spawn environment, for a closed-registration server
- [ ] add a **Test connection** button and a `#connect-check` result area to the connect card. The permission request stays synchronous in the click handler.
- [ ] route **Continue** through `checkServer`. Keep the last result and use `registrationOpen === false` to open the auth step on **Sign in**, with the "Sign-up is closed on this server." note on the register tab.
- [ ] write e2e tests:
  - Test connection against the real e2e server shows "Connected to BookSync" with the version;
  - a closed-registration server opens on Sign in.
- [ ] write e2e tests for failure: a port from `freePort()` with nothing on it shows the red "not reachable" result, and Continue stays on the connect step
- [ ] check that the existing `connect()` helper, which every other spec uses, still passes unchanged
- [ ] run `npm run check`, `make e2e` and `make e2e-edge` - must pass before next task

### Task 5: Server card when signed in

**Files:**
- Modify: `extension/src/ui/options/options.ts`
- Modify: `extension/e2e/options.spec.ts`

- [ ] add a **Server** card to the signed-in view: address, status dot and text from `describeServerCheck`, "checked HH:MM", and a **Check now** button (busy state while running)
- [ ] keep the result in module-level state as specified: the first signed-in render and **Check now** fire it; completion updates only `#server-card`; sign-out or a server change clears it
- [ ] check `permissions.contains` first; "Permission missing" makes **Check now** re-request the permission synchronously
- [ ] write e2e test: signed in, the card shows "Reachable", and still does after **Sync now** re-renders the page
- [ ] write e2e test: stop the e2e server, click **Check now** → "Not reachable"
- [ ] run `npm run check`, `make e2e` and `make e2e-edge` - must pass before next task

### Task 6: Verify acceptance criteria
- [ ] verify all requirements from Overview are implemented
- [ ] verify edge cases are handled:
  - an old server without `/v1/info`;
  - storage down;
  - closed registration;
  - an escaped `Host`.
- [ ] run full test suite: `make test` and `make lint`
- [ ] run e2e tests: `make e2e` and `make e2e-edge`
- [ ] verify coverage: `go test -cover ./internal/...` ≥ 80 %
- [ ] run `make docker-smoke` (extended in Tasks 1 and 2)

### Task 7: [Final] Update documentation
- [ ] `docs/protocol.md` §3.2: add `GET /` (HTML, informational) and `GET /v1/info` (schema and `protocol` meaning above); note that clients must tolerate its absence and ignore unknown fields
- [ ] `docs/protocol.md` §3.1: `GET /` is the one non-JSON success response; 404 and 405 stay JSON
- [ ] README: mention the home page under Self-hosting (open `https://your-domain/` to check the server) and the Test connection button
- [ ] CLAUDE.md:
  - home page rules: no JS; CSS only in `home.css`, hashed into the CSP and inserted as `template.CSS`; no inline `style=` attributes;
  - `checkServer` / `serverOrigin` are the one way the UI probes a server.
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification:**
- view the home page in light and dark mode, at phone width and on desktop, in Chrome,
  Edge and Firefox
- behind the Synology reverse proxy and Caddy: the "Connect your browser" address shows
  `https://` and the public host
- Firefox: the Test connection permission prompt appears on the first click (the gesture
  is kept)

**External system updates:**
- none. Older extensions ignore `/v1/info`, and newer extensions fall back to `/healthz`
  on older servers.
