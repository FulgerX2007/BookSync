# Security policy

BookSync is end-to-end encrypted. A BookSync server must never learn your bookmarks
or keys, and it must not be able to change your bookmarks without your devices
noticing. This page says how to report a vulnerability, what counts as one and what
happens next.

## Reporting a vulnerability

Report it privately through GitHub:
**[Report a vulnerability](https://github.com/FulgerX2007/BookSync/security/advisories/new)**
(the repository's **Security** tab, then **Report a vulnerability**).

- **Don't open a public issue, pull request or discussion** for a vulnerability.
- **Include:**
  - the component (server, browser extension, Android app, deploy bundle or release
    pipeline), its version and, for the extension, the browser;
  - steps to reproduce, or a proof of concept;
  - what an attacker gains, and what position they need: the network, the server
    operator, another account on the same server, or another app or extension on the
    device.
- **One issue per report**, please. Related findings can share one report.

## What happens next

These are our targets:

| Step | Target |
|---|---|
| Acknowledge the report | 7 days |
| Confirm or reject it, with a severity | 14 days |
| Release a fix for a critical or high-severity issue | 30 days after confirmation |
| Release a fix for a medium or low-severity issue | the next regular release |
| Disclose it publicly | once the fix is released, at most 90 days after the report |

- **We keep you informed** in the private advisory, and credit you in it unless you'd
  rather not be named.
- **A confirmed issue** in a released version gets a published GitHub Security Advisory
  and a CVE.
- **Protocol and crypto flaws can take longer.** The key derivation inputs, `info` and
  AAD strings and the envelope format can't change in place: that would lock every
  existing user out. The fix is a new protocol version plus a migration
  ([docs/protocol.md](docs/protocol.md)). We then agree a disclosure date with you.
- **There is no bug bounty.**

## Supported versions

Only the latest [release](https://github.com/FulgerX2007/BookSync/releases) gets
security fixes. Fixes are not backported.

| Component | How a fix reaches you |
|---|---|
| Server: the `ghcr.io/fulgerx2007/booksync-server` image, a release binary or a source build | **You update it yourself.** Move to the new image tag, or `git pull` and rebuild (README, [Self-hosting](README.md#self-hosting)). |
| Browser extension | A store install updates automatically. A release zip or an unpacked build must be replaced by hand. |
| Android app | Install the new APK from the release. |

Server operators: to hear about fixes, **Watch** this repository with **Custom →
Releases** and **Security alerts** selected.

## In scope

The threat model is in the README's [Security model](README.md#security-model) and in
[docs/protocol.md](docs/protocol.md) §1. In short, the server is trusted to store and
serve data, not to read it or alter it. We want to hear about:

- **Confidentiality.** Any way for a server, a network attacker or another account to
  learn a title, a URL, the folder structure, a password, a SyncID, the key-encryption
  key or the vault key.
- **Integrity.** Any way to change, replay or roll back a vault without the clients
  detecting it. Examples: a client accepting weakened key derivation parameters, a
  forged or modified envelope, or a vault older than one the device has already
  synced.
- **Silent data loss that someone else can trigger.** Bypassing the mass-deletion
  confirmation or the rollback check, or making a sync delete bookmarks the user didn't
  delete.
- **Server** (`cmd/`, `internal/`):
  - bypassing authentication, or using another device's or account's token;
  - reading, changing or deleting another account's data;
  - finding out which usernames exist through sign-in: the prelogin and login
    responses, or their timing;
  - getting around the sign-in rate limits;
  - injection, or a few requests that can take the server down.
- **Clients** (`extension/`, `android/`, `internal/client/`, `mobile/`):
  - script injection into extension pages or the app through bookmark titles or URLs;
  - keys, the SyncID or bookmarks leaking to logs, to other extensions or apps, or to
    a server other than the one the user entered;
  - a client talking to a non-local server over plain HTTP;
  - the Android app exposing secrets through backups or screenshots of its secret
    screens.
- **Deploy bundle** (`deploy/`): an insecure default in the compose files, the
  Caddyfile or the Dockerfile.
- **Release pipeline** (`.github/workflows/`, `scripts/`): anything that could leak the
  signing or store keys, or let an outsider change a release.

## Not vulnerabilities

These are known and documented, so please don't report them:

- **Metadata the server sees by design:** usernames, device names, client IPs, sync
  times, the number of versions and each vault's size.
- **A malicious server refusing service.** It can withhold or delete data and refuse
  uploads. Clients detect tampering and rollback; they can't make a server keep data.
- **Rollback towards a device that hasn't seen the newer vault.** Each device detects
  rollback against the newest vault it has synced. A device that is signing in for the
  first time has nothing to compare against.
- **A revoked device still holds the keys.** Revoking stops its syncing; rotating the
  encryption keys and SyncID protects future data (README, Security model).
- **Losing every signed-in device and the emergency kit** makes an account
  unrecoverable. That is the cost of end-to-end encryption.
- **Attacks that need control of the device:** the OS account, the browser profile, or a
  rooted or unlocked phone. The extension keeps its session, including the SyncID and
  the device token, in the browser profile.
- **Open registration.** On a server that allows sign-up, anyone can store up to the
  vault limit, and registering tells whether a username is taken. Operators close it
  with `BOOKSYNC_ALLOW_REGISTRATION=false`.
- **Operator misconfiguration.** For example, serving without TLS, or publishing the
  server's own port while `BOOKSYNC_TRUST_PROXY_HEADERS=true`, which lets clients choose
  the IP the rate limits see. The bundled compose files expose the server only to its
  proxy.
- **Volumetric denial of service**, and guessing passwords no faster than the rate
  limits allow.
- **Scanner output without a working attack.** For example, a missing header on a
  response that carries no secrets, the version on the server's home page (shown on
  purpose), or an outdated dependency with no exploitable path in BookSync.

## Testing

- **Use your own server.** The BookSync project runs no public server. Start one with
  `make run` (`http://localhost:8080`) or with the compose bundle.
- **Don't test against a server you don't operate** without its operator's permission,
  and don't access accounts that aren't yours.
- **Stop once you have shown the issue.** Don't keep or share data you got through it.

We won't take legal action over research that follows this page in good faith.
