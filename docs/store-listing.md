# Store listings

Copy-paste text and images for the Chrome Web Store, Microsoft Edge Add-ons,
Firefox Add-ons (AMO) and [Google Play](#google-play-android-app). Images are in [`extension/store/assets/`](../extension/store/assets/);
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

- **Compatibility:** Firefox (desktop) only, because Firefox for Android has no
  bookmarks API (installed there anyway, the extension says so instead of running).
  - The manifest has no `browser_specific_settings.gecko_android` key, so AMO lists
    the add-on for desktop Firefox only. Never add that key: it marks the add-on as
    Android-compatible and locks that setting in the Developer Hub.
  - `web-ext lint` therefore warns `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`
    (`data_collection_permissions` needs Firefox for Android 142). That warning is
    expected; it is about Android, which BookSync doesn't target.
  - Versions up to 1.2.0 carried the key, so their Android compatibility is locked. The
    first version without it replaces them as the current version, and AMO then stops
    offering BookSync on Android.
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

## Google Play (Android app)

**Upload:** `booksync-android-X.Y.Z.aab` from the GitHub release (it is attached only when
Android signing is configured; see [store-publishing.md](store-publishing.md#6-google-play-internal-track)).
Package name: `io.booksync.android`.

### Main store listing

- **App name** (up to 30 characters): BookSync
- **Short description** (up to 80 characters):
  End-to-end encrypted bookmarks, synced with your browsers via your own server.
- **Category:** *Productivity*. **Tags:** Bookmarks, Sync.
- **Contact email:** required by Play; use the address that owns the developer account.
- **Website:** https://github.com/FulgerX2007/BookSync

**Full description** (up to 4000 characters):

```text
BookSync keeps your bookmarks with you on Android and in sync with Chrome, Edge and
Firefox on your computers, through a server you run yourself. Everything is
end-to-end encrypted: the server stores your bookmarks, but it can never read them.

Android browsers don't let other apps read their bookmarks, so BookSync is a
bookmark app of its own: it keeps your synced bookmarks and opens them in whichever
browser you like.

FEATURES
• All your desktop bookmarks on your phone: the bookmarks bar, other bookmarks and
  their folders, synced in both directions.
• Save from any app: Share → Save to BookSync, pick a folder, done. It uploads as soon
  as the phone is online.
• Search every bookmark by any part of its title or address, ignoring case and
  accents.
• Rename, edit, move and delete bookmarks and folders.
• Safety checks: BookSync asks before a sync that would delete many bookmarks, and
  refuses to go back to an older server copy without your decision.
• Delete your account from the app at any time.

PRIVACY
• Bookmarks are encrypted on the phone (AES-256-GCM) with keys derived from your
  password and a secret SyncID. Neither ever leaves your devices.
• Local data is protected by the Android Keystore and excluded from backups.
• No ads, no analytics, no tracking. The app talks only to the server you enter.
• Open source: https://github.com/FulgerX2007/BookSync

BookSync needs a BookSync server (a single Docker container). The project's README
shows how to set one up in a few minutes. The browser extension for Chrome, Edge and
Firefox is free in their stores.
```

### Graphics

All in [`android/store/`](../android/store/):

| File | Play Console field |
|---|---|
| `icons/booksync-play-icon.png` (512×512) | App icon |
| `feature-graphic-1024x500.png` | Feature graphic |
| `screenshots/1-folders.png` … `5-welcome.png` (1080×1920) | Phone screenshots |

`make android-store-shots` re-renders the screenshots from the real Compose screens
(Robolectric, sample data in `StoreScreenshots.kt`). `cd extension && npm run
store:assets` re-renders the feature graphic along with the extension images.

### App content (Policy → App content)

- **Privacy policy:** https://github.com/FulgerX2007/BookSync/blob/main/docs/privacy.md
- **Ads:** No, the app contains no ads.
- **App access:** *All or some functionality is restricted*. Add the reviewer
  instructions from [Notes for reviewers](#notes-for-reviewers), Android variant.
- **Content rating:** questionnaire category *Utility, Productivity, Communication or
  Other*; answer No to every content question. Users don't interact or share content
  with each other. Expected rating: Everyone / PEGI 3.
- **Target audience:** 18 and over (the app is not designed for children).
- **News app:** No. **Government app:** No. **Financial features:** none.
  **Health:** none.
- **Data safety:**
  - *Does your app collect or share any of the required user data types?* **Yes**.
  - *Is all of the user data collected by your app encrypted in transit?* **Yes**
    (HTTPS).
  - *Which account creation methods does your app support?* **Username and password**.
    **Delete account URL:**
    https://github.com/FulgerX2007/BookSync/blob/main/docs/account-deletion.md
  - Data types, each *Collected*, *not shared*, *not processed ephemerally*,
    *required*, purpose **Account management**:
    - **Personal info → User IDs:** the username.
    - **Device or other IDs:** the device name the app registers (manufacturer and
      model), shown in the account's device list.
  - Bookmarks are not declared. They leave the phone only end-to-end encrypted, and
    Play exempts data that no one but the user can read. The password and SyncID
    never leave the phone.
  - This is deliberately conservative: the data goes only to the server the user
    chooses, never to the developer, but Play counts any transfer off the device.
- **Permissions:** only `INTERNET`, which needs no declaration.

## Notes for reviewers

Every store has a field for reviewer notes or test instructions (Play: *App
access*). The demo server
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

For Google Play (*App access → Add instructions*):

```text
BookSync needs a BookSync server. A test server and account are ready:

  Server URL: https://booksync.conect.md
  Username:   reviewer
  Password:   <password>
  SyncID:     <SyncID>

On the welcome screen tap "Sign in", enter the four values above and tap
"Sign in". The account's sample bookmarks (folders "Work", "Reading",
"Travel") appear under "Bookmarks Toolbar". To test sharing, share any web
page from a browser and choose "Save to BookSync".
```
