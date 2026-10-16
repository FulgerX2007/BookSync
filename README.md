# BookSync

End-to-end encrypted bookmark sync across all your browsers, through a server you host
yourself.

BookSync keeps bookmarks in two-way sync between the Chromium family (Chrome, Edge,
Brave, Vivaldi, Opera) and Firefox. Each browser sends its changes within a few seconds
and picks up everyone else's within about a minute. An Android app carries the same
bookmarks on your phone.

Native browser sync only works inside one vendor's ecosystem, and it stores your
bookmarks with that vendor. BookSync's server stores only ciphertext. It never sees a
title, a URL or your folder structure.

- **Two-way, near-live sync.**
  - Creates, renames, moves, reorders and deletes propagate between all signed-in
    browsers.
  - Concurrent edits on several browsers converge to the same tree everywhere.
- **End-to-end encrypted.** Keys are derived from your password **and** a SyncID, a
  128-bit secret generated at registration that never leaves your devices.
- **Self-hosted and multi-user.**
  - One CGO-free Go binary with SQLite, in a distroless container.
  - Caddy terminates TLS and gets certificates automatically.
- **Safe by default:**
  - a sync that would delete many bookmarks asks first;
  - the server keeps a version history you can restore from;
  - a server restored from an old backup is detected, not silently trusted.

## How it works

```
 ┌──────── Browser A (Chrome, Edge, Brave…) ────────┐   ┌──────────── Browser B (Firefox) ─────────────┐
 │ bookmarks API ⇄ adapter ⇄ projection / applier    │   │ bookmarks API ⇄ adapter ⇄ projection / applier│
 │ sync engine: 3-way merge (base, local, remote)    │   │ sync engine: 3-way merge                      │
 │ crypto: PBKDF2 → HKDF keys, AES-256-GCM vault     │   │ crypto (same code)                            │
 │ state: IndexedDB (session, vault key, base, ids)  │   │ state: IndexedDB                              │
 └───────────────────────┬───────────────────────────┘   └──────────────────────┬───────────────────────┘
                         │ HTTPS: auth JSON + opaque encrypted vault (ETag / If-Match) │
                         ▼                                                             ▼
              ┌──────────────────────────── booksync-server (Go) ───────────────────────────┐
              │ auth: Argon2id(authKey) · device tokens · rate limits · vault versions      │
              │ SQLite: users · devices · vault_versions (ciphertext only, with retention)  │
              └─────────────────────────────────────────────────────────────────────────────┘
                                 ▲ Caddy (automatic HTTPS) in docker compose
```

- **One encrypted snapshot.** Each account has one encrypted *vault*: the whole
  bookmark tree, gzipped and AES-256-GCM encrypted. The server stores it with a version
  number.
- **Optimistic locking.** A browser uploads with `If-Match: "<version>"`. If another
  browser got there first, the server answers `412`, and the browser merges again
  before retrying.
- **All merging happens in the extension.** The extension runs a deterministic
  three-way merge of the last synced tree, the browser's tree and the server's tree:
  - an edit beats a delete;
  - on a true conflict, the version already on the server wins.
- **Polling, no push.** Browsers poll every minute with `If-None-Match`. A poll with
  nothing new is a `304` and costs almost nothing.

The full specification (cryptography, vault format, API, merge rules, browser mapping)
is in [docs/protocol.md](docs/protocol.md).

## Security model

| The server learns | The server cannot learn |
|---|---|
| usernames, device names, client IPs, sync times, the number of versions, the size of each vault (a rough proxy for library size) | titles, URLs, folder structure, the exact bookmark count, your password, your SyncID, the vault key |

- **Two secrets.**
  - Signing in needs your username, your password **and** your SyncID.
  - The SyncID is mixed into key derivation and never sent to the server.
  - A stolen server database therefore can't be cracked offline: an attacker would
    have to guess the password and 128 random bits.
- **The server cannot tamper.**
  - Vault contents are authenticated (AES-GCM, bound to their user and purpose).
  - Replaying an old vault is detected by a counter inside the ciphertext.
  - The extension refuses weakened key-derivation parameters.
  - A malicious server can still refuse service.
- **Your emergency kit is the only way back in.**
  - The SyncID is shown once at registration, with a downloadable emergency kit.
  - Signed-in browsers can show it again.
  - If you lose every signed-in browser **and** the kit, the account cannot be
    recovered. That is the price of end-to-end encryption.
- **Lost or stolen device: rotate keys.**
  - Revoking a device under *Devices* stops it from syncing. But it already holds
    your SyncID and vault key.
  - To protect future data, go to *Change password* and tick **"A device was lost or
    stolen: also rotate the encryption keys and SyncID"**.
  - This re-encrypts the vault under a new key, replaces the server history, signs out
    every other device and gives you a new emergency kit.
  - Other browsers then sign in with the new SyncID.
- **Password change.** It re-wraps the vault key and signs out your other devices. Your
  SyncID stays the same unless you also rotate.

## Self-hosting

You need:

- a host with Docker and Docker Compose;
- a DNS name pointing at it;
- ports 80 and 443 reachable, so Caddy can obtain a certificate.

```sh
git clone https://github.com/FulgerX2007/BookSync.git && cd BookSync
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env                       # set BOOKSYNC_DOMAIN=booksync.example.com
docker compose -f deploy/docker-compose.yml up -d --build
curl https://booksync.example.com/healthz # → {"status":"ok"}
```

Open `https://booksync.example.com/` in a browser to see the server's status page: whether
it is online, its version, whether sign-up is open, the address to enter in the
extension and the API reference. `GET /v1/info` returns the same facts as JSON.

- **Network.** Only Caddy is published. The BookSync container is reachable solely
  through it, and it trusts the client IP Caddy appends to `X-Forwarded-For`.
- **Data.** Everything lives in the `booksync-data` volume (`/data/booksync.db`).
- **Updating.** `git pull` and run the same `docker compose … up -d --build`. Database
  migrations run on start.

### Using a released image

Each release publishes the server image `ghcr.io/fulgerx2007/booksync-server` for
linux/amd64 and linux/arm64. It is tagged `X.Y.Z`, `X.Y` and `latest`. To run the
compose bundle with it instead of building from source, set the image in `deploy/.env`
and pull it:

```sh
echo BOOKSYNC_IMAGE=ghcr.io/fulgerx2007/booksync-server:0.1.0 >> deploy/.env
docker compose -f deploy/docker-compose.yml pull booksync
docker compose -f deploy/docker-compose.yml up -d --no-build
```

To update, change the tag and repeat. Each
[release](https://github.com/FulgerX2007/BookSync/releases) also carries standalone
server binaries for Linux, macOS and Windows. They read the same environment variables
and belong behind a TLS-terminating proxy, as in the compose bundle.

### Synology NAS

DSM already uses ports 80 and 443 and manages certificates, so
[deploy/synology/docker-compose.yml](deploy/synology/docker-compose.yml) does without
Caddy. It runs the released image on `127.0.0.1:8080`, and DSM's reverse proxy provides
HTTPS. It needs DSM 7.2+ with Container Manager.

1. **Files.** In File Station, create `docker/booksync/data` and copy the compose file
   into `docker/booksync`.
2. **User.** The container runs as `1026:100` so it can write to `data/`. Over SSH,
   run `id <your-dsm-user>`. If the uid or gid differs, change `user:` to match.
3. **Project.** Container Manager → Project → Create, path `/volume1/docker/booksync`,
   "Use existing docker-compose.yml".
4. **Certificate.** Point `booksync.example.com` at the NAS. Then add a Let's Encrypt
   certificate in Control Panel → Security → Certificate.
5. **Reverse proxy.** Control Panel → Login Portal → Advanced → Reverse Proxy → Create:
   - source `HTTPS`, `booksync.example.com`, port `443`;
   - destination `HTTP`, `localhost`, port `8080`;
   - Custom Header → Create: `X-Forwarded-For` = `$proxy_add_x_forwarded_for`.
     Without it, every client shares one rate-limit bucket.

   In the Certificate settings, assign the new certificate to this hostname.
6. **Check.** Open `https://booksync.example.com/`: the status page should say
   **Online** and show the `https://` address to enter in the extension.

- **Data** is in `/volume1/docker/booksync/data/booksync.db`, so Hyper Backup and
  snapshots cover it. A snapshot is only consistent with the project stopped. Otherwise,
  use the online backup command below with `-v /volume1/docker/booksync/data:/data`.
- **Updating.** The image tag is `latest`. In Container Manager, stop the project and
  choose Action → Build (it pulls), or run `docker compose pull && docker compose up -d`
  in the folder. Pin a tag such as `0.1.0` if you prefer explicit upgrades.
- **Settings** are environment variables in the compose file (table below);
  `BOOKSYNC_DOMAIN` and the port variables don't apply here.

### Configuration

Every setting is an environment variable in `deploy/.env`
(see [deploy/.env.example](deploy/.env.example)):

| Variable | Default | Purpose |
|---|---|---|
| `BOOKSYNC_DOMAIN` | — | public DNS name; Caddy gets its certificate |
| `BOOKSYNC_ALLOW_REGISTRATION` | `true` | allow new accounts |
| `BOOKSYNC_MAX_VAULT_BYTES` | `10485760` | maximum encrypted vault size (10 MiB holds tens of thousands of bookmarks) |
| `BOOKSYNC_VAULT_KEEP_RECENT` | `10` | newest versions always kept |
| `BOOKSYNC_VAULT_KEEP_DAYS` | `30` | also keep the newest version of each day for this many days (`0` disables) |
| `BOOKSYNC_TOKEN_TTL` | `2160h` | a device is signed out after this long without syncing |
| `BOOKSYNC_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `BOOKSYNC_HTTP_PORT` / `BOOKSYNC_HTTPS_PORT` | `80` / `443` | host ports Caddy listens on |

### Closing registration

There are no per-user quotas, so an open server lets anyone store data on it. Once your
accounts exist, close registration:

```sh
echo BOOKSYNC_ALLOW_REGISTRATION=false >> deploy/.env
docker compose -f deploy/docker-compose.yml up -d
```

Existing users keep working. New sign-ups get "registration is closed on this server".

### Backups

The database holds only ciphertext and Argon2id hashes. Backups are still worth
protecting, but leaking one does not expose bookmarks.

**Option 1: stop the server, copy the volume, start it again.**

```sh
docker compose -f deploy/docker-compose.yml stop booksync
docker run --rm -v booksync_booksync-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/booksync-$(date +%F).tgz -C /data .
docker compose -f deploy/docker-compose.yml start booksync
```

**Option 2: an online copy with SQLite's backup API.** The server keeps running.

```sh
docker run --rm -v booksync_booksync-data:/data -v "$PWD":/backup alpine \
  sh -c 'apk add -q sqlite && sqlite3 /data/booksync.db ".backup /backup/booksync-$(date +%F).db"'
```

Continuous replication tools such as Litestream work too.

### After restoring a backup

A restored database is older than what your browsers last saw. BookSync notices this
because every vault carries an encrypted sequence number. Browsers then stop with
**"Server copy is older than this browser"** (`rollback_detected`) instead of silently
undoing your recent changes. To recover:

1. **On the browser with the most up-to-date bookmarks,** choose **"This browser's"**
   in the popup (**"Use this browser's bookmarks"** in settings). This uploads its tree as the
   newest version.
2. **The other browsers** then merge normally on their next sync. If one still reports
   the problem, choose **"Use this browser's bookmarks"** there too (its newer changes
   merge in), or **"Accept the server's version"** to discard what the backup lacks.
   Large deletions still ask for confirmation.
3. **Browsers registered after the backup was taken** no longer exist on the server.
   They get signed out; sign in again with your username, password and SyncID.
   Accounts created after the backup must register again.

## Installing the extension

BookSync is not yet listed on the Chrome Web Store, Edge Add-ons or Firefox Add-ons.
Until it is, download `booksync-chromium-X.Y.Z.zip` and `booksync-firefox-X.Y.Z.zip`
from the [releases](https://github.com/FulgerX2007/BookSync/releases), or build them
from source (Node.js 22 or newer):

```sh
cd extension
npm ci
npm run build            # → dist/chromium and dist/firefox
```

**Chromium browsers (Chrome 120+, Edge, Brave, Vivaldi, Opera)**

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`, …).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `extension/dist/chromium`, or the folder you
   unzipped `booksync-chromium-X.Y.Z.zip` into.

**Firefox 140+**

- For a quick try: open `about:debugging#/runtime/this-firefox`, click **Load Temporary
  Add-on…** and select `extension/dist/firefox/manifest.json` or
  `booksync-firefox-X.Y.Z.zip`. The add-on is removed when Firefox restarts.
- For a permanent install, sign the build for self-distribution on
  [addons.mozilla.org](https://addons.mozilla.org/developers/) (`npx web-ext sign`).
  Alternatively, use Firefox Developer Edition or Nightly with
  `xpinstall.signatures.required` set to `false`.

`make package` builds store-ready zips in `extension/dist/packages/`.

### First use

1. Open BookSync's settings: click the toolbar icon, then **Settings**.
2. **Register** with your server URL (for example `https://booksync.example.com`), a
   username, a password and a name for this browser.
   - The browser asks for permission to contact that server.
   - BookSync then shows your **SyncID**. Download the emergency kit and keep it
     somewhere safe (a password manager is ideal).
3. In every other browser, install BookSync and **Sign in** with your username, password
   and SyncID. Existing bookmarks on both sides are merged without duplicates.

**Toolbar icon:**

- The popup shows the sync state and offers **Sync now** and **Pause**. The badge shows
  `!` when BookSync needs you, and `‖` while paused.
- When BookSync needs a decision, the popup shows it:
  - confirming a large deletion;
  - a server restored from a backup;
  - browser sync detected;
  - bookmark folders that changed.

**Settings page:**

- **Test connection** before connecting, and a **Server** card once signed in, showing
  whether the server is reachable (with **Check now**);
- devices (with revoke);
- your SyncID and emergency kit;
- password change (with key rotation);
- the version history, with restore;
- account deletion.

**Browser account sync.** Turn off the browser's own bookmark sync (Google, Microsoft
or Firefox account) before using BookSync. Running both duplicates bookmarks. BookSync
detects it only in Chrome 134+, through the `syncing` flag Chrome sets on bookmark
folders that belong to a Google account, and pauses until you acknowledge it. It does
not detect Firefox Sync, and Microsoft Edge sync has not been confirmed to set that
flag. In those browsers, turning it off is up to you.

## Finding and organizing bookmarks

BookSync works on the browser's own bookmarks, so these tools work the same in Chrome,
Edge, Brave, Vivaldi, Opera and Firefox. They work signed out too. Every change reaches
your other browsers through the normal sync.

- **Search from the toolbar.** Open the popup and type any part of a bookmark's title
  or URL:
  - case and accents don't matter (`cafe` finds *Café*);
  - several words must all match;
  - each result shows its folder;
  - use ↑/↓ and Enter, or click, to open a result in a new tab.
- **Bookmark this page.** In the popup, pick a folder and a name. If the page is
  already bookmarked, the popup says where. This uses the `activeTab` permission, which
  only applies when you open the popup.
- **Manage bookmarks** (button in the popup) opens a full-tab manager:
  - **The tree.** It shows your synced folders. Double-click a bookmark to open it, or
    a folder name to rename it.
  - **Editing.** Use **New folder**, **New bookmark**, **Edit** and **Delete**, or the
    ✎ and 🗑 buttons on each row. Deleting a folder, or several items, asks first and
    names the counts.
  - **Search.** The search box lists matching bookmarks and folders; click a result to
    jump to it in the tree.
  - **Drag and drop.** Drop an item near the top or bottom edge of a row to place it
    before or after that row, or onto the middle of a folder to move it inside.
  - **Multi-select.** Ctrl/⌘-click or Shift-click selects several items, which you can
    then drag or delete together.
  - **Live updates.** The manager follows changes made by sync or by the browser.
  - **Locked roots.** The root folders (Bookmarks bar, Other bookmarks, …) can't be
    renamed, moved or deleted.

## Android app

Android browsers don't let other apps read or write their bookmarks. Since Android 6
none of them do (Chrome, Firefox, Edge, Brave, Samsung Internet), and Firefox for
Android's add-ons have no bookmarks API. So the app doesn't sync a phone browser.
Instead **it is a BookSync device of its own**: it keeps your bookmarks, opens them in
whichever browser you like, and syncs them with your desktop browsers.

- **Install.** Download `booksync-android-X.Y.Z.apk` from the
  [releases](https://github.com/FulgerX2007/BookSync/releases) when one is attached, or
  build it yourself (see [Development](#development)). It needs Android 8.0 or newer.
- **Sign in or register.**
  - Sign in with the same server, username, password and SyncID as your browsers.
  - Or create the account on the phone and save the emergency kit it shows. The kit
    screen doesn't allow screenshots; copy the kit or share it to your password
    manager.
- **Browse and edit.**
  - The four top-level folders hold your synced bookmarks.
  - Tap a folder to open it, or a bookmark to open it in your browser (http and https
    links only).
  - Long-press for **Rename**, **Edit URL**, **Move** and **Delete**, and use **+** to
    add a bookmark or folder.
  - **Search** works like the extension's: any part of a title or URL, ignoring case
    and accents.
- **Save from any app.** In a browser or any other app, choose **Share → Save to
  BookSync**, pick a folder, and save. The bookmark is uploaded in the background as
  soon as the phone is online.
- **When it syncs.**
  - While the app is open: at start, a few seconds after an edit, every minute, and
    when you pull down to refresh.
  - When the app is closed: only to upload something you shared.
  - The bar under the title shows the state.
  - The app asks before a large deletion, and when the server holds an older copy than
    the phone has seen.
- **Signing out** removes the bookmarks from the phone. They stay on the server and your
  other devices.

**Security on the phone.**

- Everything BookSync stores on the phone is encrypted with a key that the Android
  Keystore protects.
- The app is excluded from backups and device-to-device transfer. A phone restored from
  a backup therefore starts signed out; sign in again.
- **Private certificate authorities:** the app connects with Go's TLS stack, which trusts
  Android's system certificates but not ones you installed yourself. Your server needs a
  publicly trusted certificate, which the bundled Caddy obtains automatically.

## Development

The repository contains the Go server and the TypeScript WebExtension.

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

### Prerequisites

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

### Running locally

```sh
make run      # server on http://localhost:8080, database ./booksync.db, debug logging
cd extension && npm ci && npm run build
```

Load `extension/dist/chromium` unpacked and register against `http://localhost:8080`.
Plain HTTP is accepted only for `localhost` and `127.0.0.1`.

### Tests

| Command | What it runs |
|---|---|
| `make test` | Go tests with `-race` (server, client core and the `mobile/` facade), plus the extension's typecheck, lint and unit tests (`npm run check`) |
| `make test-go` / `make test-mobile` / `make test-ext` | one part |
| `make lint` | golangci-lint, for both Go modules |
| `make android-aar` | the Go core as `android/app/libs/booksync-core.aar` |
| `make android-test` | the AAR, then the Android version tests, JVM unit and UI tests (Robolectric) and lint |
| `make android-apk` | the AAR, then the release APK (signed when the `ANDROID_KEYSTORE_*` variables are set) |
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

### Releasing

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
   - `booksync-android-X.Y.Z.apk`, if signing is configured;
   - `SHA256SUMS`.

**Android signing.** The APK is attached only when these repository secrets exist:

- `ANDROID_KEYSTORE_BASE64` (the upload keystore, base64-encoded);
- `ANDROID_KEYSTORE_PASSWORD`;
- `ANDROID_KEY_ALIAS`;
- `ANDROID_KEY_PASSWORD`.

Without them the release succeeds without an APK and the workflow logs a warning: an
unsigned APK can't be installed. The app's `versionCode` comes from the tag:
`X·1000000 + Y·10000 + Z·100`, plus `N` for `-rc.N` or 99 for a final release.

A tag such as `v0.2.0-rc.1` publishes a pre-release. It gets no `0.2` or `latest`
image tag, and its extension carries `0.2.0`, because browser stores accept only plain
numbers.

`make dist` builds the same artifacts locally. Without `VERSION` it uses `git describe`;
`extension/package.json`'s version only applies to builds that aren't from a tag.

The first release creates the GHCR package. If anonymous pulls fail, make the package
public in its settings (your profile → **Packages** → `booksync-server`).
