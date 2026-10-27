# Self-hosting BookSync

Running your own BookSync server: the Docker bundle, a released image, a Synology NAS,
settings, storage limits, backups and recovery.

## Docker Compose bundle

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

## Using a released image

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

## Synology NAS

DSM already uses ports 80 and 443 and manages certificates, so
[deploy/synology/docker-compose.yml](../deploy/synology/docker-compose.yml) does without
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

## Configuration

Every setting is an environment variable in `deploy/.env`
(see [deploy/.env.example](../deploy/.env.example)):

| Variable | Default | Purpose |
|---|---|---|
| `BOOKSYNC_DOMAIN` | — | public DNS name; Caddy gets its certificate |
| `BOOKSYNC_ALLOW_REGISTRATION` | `true` | allow new accounts |
| `BOOKSYNC_MAX_VAULT_BYTES` | `10485760` | default encrypted vault limit per account (10 MiB holds tens of thousands of bookmarks); see [per-account limits](#per-account-storage-limits) |
| `BOOKSYNC_VAULT_KEEP_RECENT` | `1` | newest versions always kept; `1` keeps only the current one, so history is one version per day |
| `BOOKSYNC_VAULT_KEEP_DAYS` | `30` | also keep the newest version of each day for this many days (`0` disables) |
| `BOOKSYNC_TOKEN_TTL` | `2160h` | a device is signed out after this long without syncing |
| `BOOKSYNC_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `BOOKSYNC_HTTP_PORT` / `BOOKSYNC_HTTPS_PORT` | `80` / `443` | host ports Caddy listens on |

## Per-account storage limits

Every account gets `BOOKSYNC_MAX_VAULT_BYTES` unless you give it its own limit with the
`quota` command:

```sh
# Show alice's limit and use
docker compose -f deploy/docker-compose.yml exec booksync booksync-server quota alice
#   alice: limit 10 MiB (server default), vault 230 KiB (2%)

docker compose -f deploy/docker-compose.yml exec booksync booksync-server quota alice 50M
docker compose -f deploy/docker-compose.yml exec booksync booksync-server quota alice default
```

- **Sizes** are in bytes, or with `K`, `M` or `G` (binary), between 1K and 64M.
- **Running server.** The command works while the server runs, and the change applies
  to the next upload.
- **Over the limit.** An upload larger than the account's limit is refused, and that
  account's syncing stops until bookmarks are removed or the limit is raised.
- **Lowering a limit** below an account's current vault keeps what is stored.
- **What users see.** The extension popup shows each user their use: a bar normally,
  and a warning card from 80 % of their limit.

## Closing registration

Every new account gets the default limit, so an open server lets anyone store up to
that much on it. Once your accounts exist, close registration:

```sh
echo BOOKSYNC_ALLOW_REGISTRATION=false >> deploy/.env
docker compose -f deploy/docker-compose.yml up -d
```

Existing users keep working. New sign-ups get "registration is closed on this server".

## Backups

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

## After restoring a backup

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
