# Deleting your BookSync account

BookSync is self-hosted: your account lives on the BookSync server you signed up on
(yours, or one someone runs for you). Nobody else, including the BookSync project, holds
a copy of it.

## What deletion removes

Deleting an account removes these from the server, immediately and permanently:

- the account (username and password verifier);
- every signed-in device and its session token;
- every stored copy of your encrypted bookmarks, including the version history.

Nothing is kept afterwards, and nothing can be restored. The server only ever held your
bookmarks encrypted, so it held nothing readable to begin with.

Deletion doesn't touch bookmarks that are already in your browsers. The other devices
are signed out the next time they sync and keep what they have. The Android app removes
its own copy when you delete the account from it.

## From the Android app

1. Open BookSync, then the **⋮** menu → **Delete account**.
2. Type your username and your password.
3. Tap **Delete permanently**.

## From the browser extension

1. Open the extension's **Options** page (right-click the toolbar icon → **Options**).
2. Under **Sign out or delete** → **Delete account**, type your username and your password.
3. Click **Delete account**.

## Without a device

If you can no longer sign in anywhere, ask the person who runs your server to delete the
account (see below). Have your username ready. You can't prove ownership without the
password and SyncID, so it is up to them whether to act on the request.

## For server operators

To delete an account by hand, run this against the database volume of the compose
bundle; the server can keep running. The `PRAGMA` is required: the `sqlite3` shell
doesn't enforce foreign keys by default, and without it the cascade to devices and vault
versions would not run.

```sh
docker run --rm -v booksync_booksync-data:/data alpine \
  sh -c 'apk add -q sqlite && sqlite3 /data/booksync.db \
    "PRAGMA foreign_keys=ON; DELETE FROM users WHERE username = '\''alice'\'';"'
```

Usernames are stored lowercase. Backups you made earlier still contain the account's
encrypted data until you rotate them out.
