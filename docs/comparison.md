# BookSync compared with xBrowserSync and Floccus

Three tools that sync a browser's own bookmarks between Chromium browsers and Firefox.
BookSync is the only one with end-to-end encryption that is always on, plus checks that
stop a single bad sync from wiping every browser. Floccus leads on maturity and on choice
of backend. xBrowserSync has had no release since 2020.

BookSync's figures come from this repository. The others come from their public docs;
"not documented" means those docs don't say, not that the feature is missing. Checked
October 2026.

## At a glance

| | BookSync | xBrowserSync | Floccus |
|---|---|---|---|
| Status | Active; not yet in the extension stores | Stalled: latest release v1.5.2, mid-2020 | Active: about 8.6k GitHub stars, in all major extension stores |
| License | None yet | GPL-3.0 | MPL-2.0 |
| Server | Its own: one Go binary with SQLite | Its own: Node.js with MongoDB, or a public instance | None of its own: uses Nextcloud Bookmarks, WebDAV, Google Drive, Dropbox, Git, Linkwarden or Karakeep |

## Security

| | BookSync | xBrowserSync | Floccus |
|---|---|---|---|
| End-to-end encryption | Always on | Always on | Optional, only with WebDAV or Google Drive; Nextcloud, Git and Linkwarden store bookmarks in plain text |
| Keys | Password plus a 128-bit SyncID that never leaves the devices; PBKDF2 (600k iterations), HKDF, AES-256-GCM. A stolen database can't be cracked offline. | Password plus sync ID; algorithm not documented | A passphrase; algorithm not documented |
| Server access | Accounts with an Argon2id login hash, per-device tokens you can revoke, sign-in rate limits | Anonymous: the sync ID is the only identifier | As strong as the chosen backend's login |
| Malicious server | Weakened key settings are refused; tampering and replay of an old vault are detected | Not documented | Not documented |

## Sync and safety

| | BookSync | xBrowserSync | Floccus |
|---|---|---|---|
| Merging | Three-way merge (last synced tree, this browser, server), the same result on every device. An edit beats a delete; on a true conflict the server's version wins. | Not documented | Merge by default; upload-only, download-only, or push or pull once |
| Mass-deletion guard | Asks before a sync deletes 20 or more bookmarks that are also over 25% of the tree | Not documented | Not documented |
| Server restored from a backup | Detected through an encrypted sequence number; the user decides what to keep | Not documented | Not documented |
| History and restore | Current version plus the last version of each day for 30 days, restore from settings | Manual backup and restore of a file | With the Git backend, its commit history |
| Browser's own sync | Detected in Chrome; every other browser shows where to switch it off | Not documented | The guides warn it causes duplicates |
| Speed | Own changes go out about 3 s after an edit; others' arrive within a minute | Not documented | A sync interval you choose |
| Size limit | 10 MiB per account by default, settable per user | 500 KB per sync by default | Up to the backend |

## Clients

| | BookSync | xBrowserSync | Floccus |
|---|---|---|---|
| Desktop browsers | Chrome, Edge, Brave, Vivaldi, Opera, Firefox | Chrome, Firefox | Every WebExtension browser; no Safari |
| Android | Full app: a sync device of its own, with browse, edit, search and share to save | App | App in open beta |
| iOS | No | No | App in open beta |
| Extras | Storage usage bar, server status page, account deletion | Descriptions and tags | Tab sync (experimental), several profiles |

## Where BookSync stands

**Ahead**

- **Security by design.** Always encrypted, two secrets, real accounts with revocable
  devices, and refusal of weakened key settings from a malicious server.
- **Reliability.** The deletion guard, rollback detection and daily history together.
  Neither competitor documents protection against one bad sync wiping every browser.
- **A small, self-contained server.** One binary and one SQLite file, rather than a
  Nextcloud install or a MongoDB.
- **A real Android device.** The app keeps and edits bookmarks itself instead of only
  viewing them.

**Behind**

- **Distribution.** Not yet in the Chrome Web Store, Edge Add-ons or Firefox Add-ons,
  where Floccus already is.
- **Flexibility.** Floccus reuses a server people already run; BookSync needs its own.
- **iOS.** Floccus has an iOS app; BookSync has none.
- **Track record.** Floccus has years of users and bug reports behind it.

## Sources

- [xbrowsersync.org](https://www.xbrowsersync.org/) and the
  [xBrowserSync API](https://github.com/xbrowsersync/api)
- [Floccus on GitHub](https://github.com/floccusaddon/floccus) and the
  [Floccus guides](https://floccus.org/guides/)
- [Bryce Wray on Floccus (2026)](https://brycewray.com/posts/2026/07/what-floccus-cross-browser-bookmarks-sync/)
- [AlternativeTo: xBrowserSync](https://alternativeto.net/software/xbrowsersync/)
