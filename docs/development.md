# Developing BookSync

The repository holds the Go server, the TypeScript WebExtension, and the Android app with
its Go client core. [CLAUDE.md](../CLAUDE.md) has the conventions and the invariants that
must hold.

## Layout

```
cmd/booksync-server/   server entry point (+ `healthcheck` subcommand for the container)
internal/              config, store (SQLite + migrations), auth (Argon2id, tokens), api (HTTP)
deploy/                Dockerfile, docker-compose.yml, Caddyfile, .env.example, smoke.sh
  synology/            compose file for Synology Container Manager (behind DSM reverse proxy)
internal/client/       Go client core for the Android app: crypto, vault, merge, api, store,
                       ops (edits), engine (session + sync); testserver for client tests
mobile/                gomobile facade over internal/client (nested Go module)
android/               Kotlin + Jetpack Compose app (bindings to the core AAR, UI, share target)
testdata/conformance/  golden corpus: TS reference → Go replay, and Go → TS fixtures
extension/
  src/crypto/          SyncID, key derivation, vault encryption
  src/model/           vault document, tree validation, URL match key
  src/sync/            three-way merge, first sync, guard, sync engine, restore
  src/browser/         Chromium/Firefox adapters, projection, applying changes
  src/storage/         IndexedDB state
  src/api/             typed HTTP client
  src/bookmarks/       search, selection, drop rules and edits for the popup and manager
  src/background/      service worker: scheduler, account flows, message router
  src/ui/              options page, popup (search, bookmark this page) and manager
  test/                fakes (bookmarks API, server), builders, multi-device harness
  e2e/                 Playwright tests against real Chromium and the real server
docs/protocol.md       normative protocol reference
```

## Prerequisites

- **Go 1.26+.** `go.mod` pins `toolchain go1.27.2`, which `go` downloads automatically.
- **Node.js 22+** and npm.
- **golangci-lint v2.14+** built with Go 1.27, for `make lint`:
  `GOTOOLCHAIN=go1.27.2 go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0`.
- **Chromium for the e2e tests:** `npx playwright install chromium` in `extension/`,
  or point `CHROMIUM_PATH` at a Chromium binary.
- **Docker,** for `make docker-smoke`.
- **For the Android app:**
  - JDK 21;
  - the Android SDK with platform 37 and NDK `29.0.14206865`, with `ANDROID_HOME` and
    `ANDROID_NDK_HOME` set.

  `make android-aar` installs the pinned gomobile from `mobile/go.mod` into `bin/`.

## Running locally

```sh
make run      # server on http://localhost:8080, database ./booksync.db, debug logging
cd extension && npm ci && npm run build
```

Load `extension/dist/chromium` unpacked and register against `http://localhost:8080`.
Plain HTTP is accepted only for `localhost` and `127.0.0.1`.

## Tests

| Command | What it runs |
|---|---|
| `make test` | Go tests with `-race` (server, client core and the `mobile/` facade), plus the extension's typecheck, lint and unit tests (`npm run check`) |
| `make test-go` / `make test-mobile` / `make test-ext` | one part |
| `make lint` | golangci-lint, for both Go modules |
| `make android-aar` | the Go core as `android/app/libs/booksync-core.aar` |
| `make android-test` | the AAR, then the Android version tests, JVM unit and UI tests (Robolectric) and lint |
| `make android-apk` | the AAR, then the release APK (signed when the `ANDROID_KEYSTORE_*` variables are set) |
| `make android-aab` | the AAR, then the release App Bundle for Google Play (signed the same way) |
| `make e2e` | Playwright: two Chromium profiles syncing through a real server built from this repo |
| `make e2e-edge` | the same suite in the installed Microsoft Edge (`npx playwright install msedge` installs it) |
| `make docker-smoke` | builds the image, starts the compose stack and checks TLS, health and registration |
| `make package` | store-ready extension zips |
| `make dist` | every release artifact in `dist/` (see below) |

In `extension/`:

- `npm run check` runs typecheck, lint and tests.
- `npx vitest run --coverage` measures coverage.
- `FC_RUNS=3000 npx vitest run src/sync` runs the property tests (merge, first sync,
  multi-device convergence) longer than the default.
- `npm run conformance:gen` regenerates `testdata/conformance/` after a change to the
  reference sync, crypto or model code. `npm run check` fails while the corpus is stale,
  and the Go tests replay it.

For the Go client, `BOOKSYNC_PROP_RUNS=3000 go test ./internal/client/...` runs the merge
and convergence properties longer.

CI (`.github/workflows/ci.yml`) runs the Go, extension, e2e (Chromium and Edge), Android
and docker-smoke jobs on pushes to `main` and on pull requests.

## Releasing

The tag is the version; nothing needs bumping by hand. Release either way:

- push a tag: `git tag v0.2.0 && git push origin v0.2.0`;
- or create a release with a new tag `v0.2.0` in the GitHub UI, which pushes the
  tag too.

The Release workflow (`.github/workflows/release.yml`) then:

1. reads the version from the tag (`vX.Y.Z` or `vX.Y.Z-suffix`);
2. runs the whole CI as a gate;
3. runs `make dist VERSION=0.2.0`, which stamps the version into the server and both
   extension manifests;
4. pushes the multi-arch image to GHCR with tags `0.2.0`, `0.2` and `latest`;
5. publishes the GitHub Release, or attaches to the one you created in the UI:
   - server archives for linux, darwin (amd64 and arm64) and windows (amd64);
   - both extension zips;
   - a source archive (Firefox Add-ons asks for one when reviewing);
   - `booksync-android-X.Y.Z.apk` and `booksync-android-X.Y.Z.aab` (the bundle Google
     Play takes), if signing is configured;
   - `SHA256SUMS`.

**Android signing.** The APK and the AAB are attached only when these repository secrets
exist:

- `ANDROID_KEYSTORE_BASE64` (the upload keystore, base64-encoded);
- `ANDROID_KEYSTORE_PASSWORD`;
- `ANDROID_KEY_ALIAS`;
- `ANDROID_KEY_PASSWORD`.

Without them the release succeeds without either and the workflow logs a warning: an
unsigned APK can't be installed. With Play App Signing, this keystore is your *upload*
key; Google re-signs the app for delivery. The app's `versionCode` comes from the tag:
`X·1000000 + Y·10000 + Z·100`, plus `N` for `-rc.N` or 99 for a final release.

**Store submissions.** For a final version, the release then waits for your approval
and submits the build to Firefox Add-ons, the Chrome Web Store, Edge Add-ons and the
Google Play internal track. Each store needs its keys in the `stores` environment;
[docs/store-publishing.md](store-publishing.md) explains the setup.

A tag such as `v0.2.0-rc.1` publishes a pre-release. It gets no `0.2` or `latest`
image tag, and its extension carries `0.2.0`, because browser stores accept only plain
numbers.

`make dist` builds the same artifacts locally. Without `VERSION` it uses `git describe`;
`extension/package.json`'s version only applies to builds that aren't from a tag.

The first release creates the GHCR package. If anonymous pulls fail, make the package
public in its settings (your profile → **Packages** → `booksync-server`).
