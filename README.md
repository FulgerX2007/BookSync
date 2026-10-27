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
  - the server keeps a daily version history you can restore from;
  - a server restored from an old backup is detected, not silently trusted.

## Quick start

1. **Run a server** on a host with Docker and a DNS name pointing at it:

   ```sh
   git clone https://github.com/FulgerX2007/BookSync.git && cd BookSync
   cp deploy/.env.example deploy/.env
   $EDITOR deploy/.env                       # set BOOKSYNC_DOMAIN=booksync.example.com
   docker compose -f deploy/docker-compose.yml up -d --build
   ```

   [Self-hosting](docs/self-hosting.md) covers released images, Synology, settings and
   backups.
2. **Install the extension** in each browser from the
   [releases](https://github.com/FulgerX2007/BookSync/releases), as the
   [user guide](docs/user-guide.md#installing-the-extension) describes.
3. **Register** in the first browser and keep the emergency kit it shows. **Sign in** in
   the others with the same username, password and SyncID.
4. **Turn off each browser's own bookmark sync.** BookSync shows where.
5. On the phone, use the [Android app](docs/android.md).

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

Found a vulnerability? Report it privately, as [SECURITY.md](SECURITY.md) describes. Don't
open a public issue.

## Compared with other tools

| | BookSync | [xBrowserSync](https://www.xbrowsersync.org/) | [Floccus](https://floccus.org/) |
|---|---|---|---|
| End-to-end encryption | Always on, password plus SyncID | Always on | Optional, WebDAV and Google Drive only |
| Server | Its own: one Go binary with SQLite | Its own: Node.js with MongoDB | Your existing Nextcloud, WebDAV, Git, Google Drive… |
| Protection against a bad sync | Mass-deletion guard, rollback detection, 30 days of daily history | Manual backup | Up to the backend |
| Mobile | Android app | Android app | Android and iOS (beta) |
| Status | Active | No release since 2020 | Active, widely used |

The full comparison is in [docs/comparison.md](docs/comparison.md).

## Documentation

| Document | For |
|---|---|
| [User guide](docs/user-guide.md) | Installing the extension, first use, finding and organizing bookmarks |
| [Android app](docs/android.md) | The phone app: install, sync, security |
| [Self-hosting](docs/self-hosting.md) | Running a server: Docker, Synology, settings, storage limits, backups |
| [Protocol](docs/protocol.md) | The normative spec: cryptography, vault format, API, sync rules |
| [Development](docs/development.md) | Repository layout, building, tests, releasing |
| [Comparison](docs/comparison.md) | BookSync next to xBrowserSync and Floccus |
| [Privacy policy](docs/privacy.md) | What the clients and the server store |
| [Deleting your account](docs/account-deletion.md) | Every way to delete an account |
| [Security policy](SECURITY.md) | Reporting a vulnerability |
