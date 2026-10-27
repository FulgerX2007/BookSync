# Using BookSync in your browsers

Installing the extension, signing in, and finding and organizing bookmarks. For the phone,
see [the Android app](android.md); for running a server, [self-hosting](self-hosting.md).

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

**Firefox for Android** can't run the extension: it gives extensions no bookmarks API.
Installed there anyway, the extension says so. Use the [Android app](android.md)
instead.

`make package` builds store-ready zips in `extension/dist/packages/`. The
[privacy policy](privacy.md) covers the extension and the Android app, and
[docs/store-listing.md](store-listing.md) holds the store texts. `cd extension &&
npm run store:assets` regenerates the listing images in `extension/store/assets/` from
the real extension.

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
- **Storage** shows how much of your account's limit on the server the bookmarks use.
  From 80 % it turns into a warning: at the limit, syncing stops until you remove
  bookmarks or the server's admin raises the limit.
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
flag. So every browser shows, in settings and in the popup, where to turn its own
bookmark sync off (Edge: `edge://settings/profiles/sync` → Favorites), until you
choose **Done, it's off**. Left on, it fights BookSync: bookmarks you delete come back.

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
