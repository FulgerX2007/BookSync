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

  `status` is `"ok"` or `"unavailable"` (when the store ping fails).
- **`GET /` (and `HEAD /`).** `text/html; charset=utf-8`, status 200, even when the
  status is `unavailable`: the page reports it. Headers:
  - `Content-Security-Policy: default-src 'none'; style-src 'sha256-<hash>'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
    The style hash is computed once at init from the embedded `<style>` block.
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
    `Cache-Control: no-store`.
  - `/{$}` matches only the root. Every other unknown path keeps its JSON `404`.
- **Page sections.**
  - Header: inline SVG logo, "BookSync", tagline "End-to-end encrypted bookmark sync".
  - Status panel: a pill (green "Online" / red "Storage unavailable"), version, sign-up
    open or closed, maximum vault size (human-readable).
  - "Connect your browser": the three steps, and this server's address to paste.
    - The address comes from `r.Host` and the scheme: TLS, or `X-Forwarded-Proto` only
      when `BOOKSYNC_TRUST_PROXY_HEADERS`.
    - It is HTML-escaped by `html/template`.
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

  - **Flow:** `GET /v1/info`, with an 8 s `AbortSignal.timeout`.
    - On 404, fall back to `GET /healthz`, which means an older server. The result is
      `ok`, with `null` facts.
    - `service !== "booksync"` or unparseable JSON → `not_booksync`.
    - `status: "unavailable"` → `storage_unavailable`. A `503` from healthz also maps to
      it.
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
    button. It checks once per page load and on click. Nothing is persisted.

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

- [ ] add `Version string` to `api.Deps`, defaulting to `"dev"` in `NewServer`, and set it in `main.go`
- [ ] create `serverInfo` and `(s *Server) info(ctx)`, sharing the store ping with `handleHealth` (extract a small `storageOK(ctx)` helper so both use it)
- [ ] register `GET /v1/info` → `handleInfo`, writing JSON with `writeJSON`
- [ ] write table-driven tests: ok; registration closed; `maxVaultBytes` from config; version from `Deps`; `"dev"` default
- [ ] write tests for the error path: store closed → `200` with `status: "unavailable"`; `POST /v1/info` → JSON `405`
- [ ] run `make test` and `make lint` - must pass before next task

### Task 2: Server-rendered home page

**Files:**
- Create: `internal/api/home.go`
- Create: `internal/api/home.html` (embedded with `//go:embed`)
- Create: `internal/api/home_test.go`
- Modify: `internal/api/server.go` (route `GET /{$}`)

- [ ] write `home.html`:
  - inline CSS with CSS variables for light/dark (`prefers-color-scheme`), system font stack, an inline SVG logo as a data URI favicon;
  - responsive single column below 640 px, no horizontal scroll;
  - the sections from Technical Details.
- [ ] parse the template once at init (`template.Must`); compute the `<style>` SHA-256 for the CSP at init
- [ ] `handleHome`: build the view from `s.info(ctx)` plus the derived server URL (trusted `X-Forwarded-Proto` only), set the security headers, render with `200`
- [ ] keep the API reference rows as a Go slice in `home.go`, so the template ranges over data, not hand-written HTML
- [ ] write tests:
  - `GET /` → 200, `text/html`, CSP with `script-src`-free `default-src 'none'`, status pill text, version, "sign-up open/closed";
  - `HEAD /` → 200 with no body;
  - the CSP style hash matches the served `<style>` block.
- [ ] write tests for edge cases:
  - store down → page shows "Storage unavailable";
  - `GET /nope` → still JSON `404`;
  - a `Host` header with `<script>` is escaped;
  - `X-Forwarded-Proto: https` is ignored unless proxy headers are trusted.
- [ ] run `make test`, `make lint` and `go test -cover ./internal/...` (≥ 80 %) - must pass before next task

### Task 3: `checkServer` in the extension

**Files:**
- Create: `extension/src/api/server-check.ts`
- Create: `extension/src/api/server-check.test.ts`

- [ ] implement `checkServer(baseUrl, fetchFn = fetch)` returning `ServerCheck` as specified (8 s timeout, `/v1/info` then `/healthz` fallback on 404)
- [ ] export `describeServerCheck(check)` → `{ tone: 'ok' | 'bad'; text: string }` for the UI, so the wording is unit-tested rather than living in `src/ui`
- [ ] write tests for the success cases: full info; older server (404 → healthz 200); sign-up closed
- [ ] write tests for the error cases: network error, timeout, non-JSON 200, `service` mismatch, `status: "unavailable"`, healthz 503
- [ ] run `cd extension && npm run check` - must pass before next task

### Task 4: Test connection on the connect step

**Files:**
- Modify: `extension/src/ui/options/options.ts`
- Modify: `extension/src/ui/options/options.css` (status line styles, if not already shared)
- Modify: `extension/e2e/options.spec.ts`

- [ ] add a **Test connection** button and a `#connect-check` result area to the connect card. The permission request stays synchronous in the click handler.
- [ ] route **Continue** through `checkServer`. Keep the last result and use `registrationOpen === false` to open the auth step on **Sign in**, with the "Sign-up is closed on this server." note on the register tab.
- [ ] write e2e tests:
  - Test connection against the real e2e server shows "Connected to BookSync" with the version;
  - a closed-registration server opens on Sign in.
- [ ] write e2e tests for failure: an unused localhost port shows the red "not reachable" result, and Continue stays on the connect step
- [ ] run `npm run check`, `make e2e` and `make e2e-edge` - must pass before next task

### Task 5: Server card when signed in

**Files:**
- Modify: `extension/src/ui/options/options.ts`
- Modify: `extension/e2e/options.spec.ts`

- [ ] add a **Server** card to the signed-in view: address, status dot and text from `describeServerCheck`, "checked HH:MM", and a **Check now** button (busy state while running)
- [ ] run one check per render of the signed-in view. Guard it so a status re-render does not refire it; only page load and **Check now** do.
- [ ] write e2e test: signed in, the card shows "Reachable"
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
- [ ] `make docker-smoke`: extend `deploy/smoke.sh` to assert that `GET /` returns HTML through Caddy and that `/v1/info` returns `"service":"booksync"`

### Task 7: [Final] Update documentation
- [ ] `docs/protocol.md` §3.2: add `GET /` (HTML, informational) and `GET /v1/info` (schema above); note that clients must tolerate its absence
- [ ] README: mention the home page under Self-hosting (open `https://your-domain/` to check the server) and the Test connection button
- [ ] CLAUDE.md: add the home page's no-JS / strict-CSP rule, and `checkServer` as the one way the UI probes a server
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
