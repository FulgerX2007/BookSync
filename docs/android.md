# BookSync for Android

Android browsers don't let other apps read or write their bookmarks. Since Android 6
none of them do (Chrome, Firefox, Edge, Brave, Samsung Internet), and Firefox for
Android's add-ons have no bookmarks API. So the app doesn't sync a phone browser.
Instead **it is a BookSync device of its own**: it keeps your bookmarks, opens them in
whichever browser you like, and syncs them with your desktop browsers.

- **Install.** Download `booksync-android-X.Y.Z.apk` from the
  [releases](https://github.com/FulgerX2007/BookSync/releases) when one is attached, or
  build it yourself (see [Development](development.md)). It needs Android 8.0 or newer.
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
- **Deleting the account** (menu → **Delete account**, confirmed with your username and
  password) permanently removes the account and every synced copy from the server and
  signs out all devices. Bookmarks already in your browsers stay there. See
  [docs/account-deletion.md](account-deletion.md) for the other ways to do it.

## Security on the phone

- Everything BookSync stores on the phone is encrypted with a key that the Android
  Keystore protects.
- The app is excluded from backups and device-to-device transfer. A phone restored from
  a backup therefore starts signed out; sign in again.
- **Private certificate authorities:** the app connects with Go's TLS stack, which trusts
  Android's system certificates but not ones you installed yourself. Your server needs a
  publicly trusted certificate, which the bundled Caddy obtains automatically.
