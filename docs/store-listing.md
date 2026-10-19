# Store listings

Copy-paste text and images for the Chrome Web Store, Microsoft Edge Add-ons and
Firefox Add-ons (AMO). Images are in [`extension/store/assets/`](../extension/store/assets/);
`cd extension && npm run store:assets` regenerates them from the real extension.
After the first manual publication, releases submit updates automatically:
see [store-publishing.md](store-publishing.md).

## Packages

From a GitHub release (`vX.Y.Z` tag), or `make dist`:

| Store | Upload |
|---|---|
| Chrome Web Store | `booksync-chromium-X.Y.Z.zip` |
| Edge Add-ons | `booksync-chromium-X.Y.Z.zip` (the same file) |
| Firefox Add-ons | `booksync-firefox-X.Y.Z.zip`, plus `booksync-X.Y.Z-source.tar.gz` as the source code |

Every update needs a higher version than the one in the store.

## Name and summary

- **Name:** BookSync
- **Summary** (Chrome: up to 132 characters; AMO: up to 250):
  End-to-end encrypted bookmark sync across your browsers, through your own server.
- **Category:** Chrome: *Productivity → Tools*. Edge: *Productivity*. AMO:
  *Bookmarks*.

## Description

```text
BookSync keeps your bookmarks in sync between Chrome, Edge, Firefox and the BookSync
Android app, through a server you run yourself. Everything is end-to-end encrypted:
the server stores your bookmarks, but it can never read them.

HOW IT WORKS
• Run the BookSync server (a single Docker container) on your own machine or VPS.
• Create an account in the extension, and save the emergency kit it shows you.
• Sign in with the same account in your other browsers. Bookmarks sync within about
  a minute, in every direction.

FEATURES
• Real two-way sync of your bookmarks bar, other bookmarks and their folders.
• Search all your bookmarks from the toolbar, and save the current page in one click.
• A full bookmark manager: drag and drop, rename, move, delete.
• Version history on the server: restore an earlier state of all your bookmarks.
• Safety checks: BookSync asks before a sync that would delete many bookmarks, and
  refuses to go back to an older server copy without your decision.
• See and sign out the devices on your account.

PRIVACY
• Bookmarks are encrypted in your browser (AES-256-GCM) with keys derived from your
  password and a secret SyncID. Neither ever leaves your devices.
• No analytics, no ads, no tracking. The extension talks only to the server you
  enter.
• Open source: https://github.com/FulgerX2007/BookSync

BookSync needs a BookSync server. It doesn't run one for you; the README shows how to
set one up in a few minutes.
```

## URLs

- **Homepage / support:** https://github.com/FulgerX2007/BookSync
- **Support / issues:** https://github.com/FulgerX2007/BookSync/issues
- **Privacy policy:** https://github.com/FulgerX2007/BookSync/blob/main/docs/privacy.md

## Images

| File | Chrome Web Store | Edge Add-ons | AMO |
|---|---|---|---|
| `screenshot-1-popup.png` … `screenshot-4-encryption.png` (1280×800) | Screenshots | Screenshots | Screenshots |
| `promo-small-440x280.png` | Small promo tile | Small promotional tile | – |
| `promo-marquee-1400x560.png` | Marquee promo tile | Large promotional tile | – |
| `logo-300.png` | – | Extension logo | – |

The 128 px store icon comes from the package itself (`icons/icon-128.png`).

## Chrome Web Store: Privacy tab

**Single purpose:**

```text
Sync the user's bookmarks between their browsers, end-to-end encrypted, through a
BookSync server the user runs or chooses.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| `bookmarks` | Reads the bookmarks to upload them (encrypted) and writes the changes synced from the user's other browsers. Also used by the built-in bookmark manager and search. |
| `storage` | Keeps the extension's encrypted sync state and settings. |
| `alarms` | Runs a sync every minute and retries after errors; MV3 service workers can't keep timers. |
| `activeTab` | "Bookmark this page" in the popup reads the current tab's title and URL, only when the user clicks it. |
| Host permissions (optional) | Requested at sign-in for the one server URL the user enters, so the extension can reach their BookSync server. No other site is accessed. |

**Remote code:** No, I am not using remote code.

**Data usage:** tick **Authentication information** (a key derived from the password
is sent to the user's server to sign in) and **Web history** (bookmarks, sent only
end-to-end encrypted). Then certify all three statements: not sold, not used for
unrelated purposes, not used for creditworthiness.

## Firefox Add-ons

- **Compatibility:** Firefox (desktop) only. **Untick Firefox for Android**: it has no
  bookmarks API.
- **Data collection:** the manifest declares `authenticationInfo` and `bookmarksInfo`
  as required, so Firefox shows them at install.
- **Source code:** answer *Yes* (the code is bundled with esbuild) and upload the
  source archive. Build instructions for the reviewer:

  ```text
  Requirements: Node.js 22 or newer (any OS).
  tar xzf booksync-X.Y.Z-source.tar.gz && cd booksync-X.Y.Z/extension
  npm ci
  BOOKSYNC_VERSION=X.Y.Z npm run build
  The add-on is in extension/dist/firefox (the same files as the uploaded zip).
  ```

## Notes for reviewers

All three stores have a field for reviewer notes or test instructions. The demo server
is **https://booksync.conect.md**, and its reviewer account is `reviewer`, holding a few
sample bookmarks. The password and SyncID are kept out of this repository; paste them
in from wherever you store them.

```text
BookSync needs a BookSync server. A test server and account are ready:

  Server URL: https://booksync.conect.md
  Username:   reviewer
  Password:   <password>
  SyncID:     <SyncID>

To test:
1. Click the toolbar icon → Open settings (the extension's options page).
2. Enter the server URL and click Continue; allow access to that one site.
3. Sign in with the account above. Its sample bookmarks (folders "Work",
   "Reading", "Travel") appear in the browser within a few seconds, and
   edits sync back within a minute.

You can also create a new account on the same server ("Create account").
Source: https://github.com/FulgerX2007/BookSync
```
