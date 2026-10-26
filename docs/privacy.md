# BookSync privacy policy

This policy covers the BookSync browser extension (Chrome, Edge, Firefox) and the
BookSync Android app. Both are free, open-source clients for a BookSync server. They
don't contain ads, analytics, crash reporting or any other tracking.

## Who receives your data

BookSync is self-hosted. The clients talk only to the BookSync server whose address
**you** enter when you sign in or register. That server is run by you, or by someone you
chose. The BookSync project doesn't run a server, receives no data from the clients, and
can't see your account.

## What stays on your device

- **Your password and your SyncID.** They never leave the device. Your encryption keys
  are derived from them on the device.
- **Your bookmarks in readable form.** They are encrypted on the device before upload
  (AES-256-GCM) and decrypted only on your devices.

## What the server stores

| Data | Why |
|---|---|
| Username | To identify the account |
| A hash of a key derived from your password (Argon2id) | To check sign-ins; it can't be turned back into the password |
| Your vault key, encrypted with your keys | So your other devices can decrypt your bookmarks |
| Your bookmarks, encrypted (current copy plus one version per day for the last month) | To sync them; the server can't read them |
| Device names, and when each device was created and last seen | To list and sign out your devices |
| A hash of each device's session token | To recognize signed-in devices |

The server keeps IP addresses only in memory, for rate limiting. Its request log
records method, path, status and duration, not addresses. A reverse proxy in front of
the server, such as the bundled Caddy, may log addresses under the operator's own
settings.

## Browser and phone permissions

- **Extension, `bookmarks`:** to read and write the bookmarks it syncs.
- **Extension, `storage` and `alarms`:** to keep its encrypted state, and to sync on a
  schedule.
- **Extension, `activeTab`:** so **Bookmark this page** can read the current tab's title
  and address, only when you click it.
- **Extension, host access:** asked for at sign-in, for your server's address only.
- **Android, network access:** to reach your server, and to upload a shared bookmark
  in the background once the phone is online.

## Sharing and selling

Your data isn't sold or shared with anyone. Nothing goes to the BookSync project or to
third parties. Data leaves your device only to reach the server you configured.

## Keeping and deleting data

The server keeps your data until you delete the account. Deletion removes everything
listed above at once; see [Deleting your BookSync account](account-deletion.md).
Signing out removes the session from the device. The extension also keeps your
bookmarks in the browser, and the Android app removes its copy.

## Changes and contact

Changes to this policy are published in this file; its history is the
[git log](https://github.com/FulgerX2007/BookSync/commits/main/docs/privacy.md).
Questions: open an issue at
[github.com/FulgerX2007/BookSync](https://github.com/FulgerX2007/BookSync/issues).
