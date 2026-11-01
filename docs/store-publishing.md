# Publishing to the stores automatically

Every final release (`vX.Y.Z`, not `-rc.N`) ends with a **Store submissions** job in
`.github/workflows/release.yml`. It waits for your approval. Once you approve, it
submits the release to:

- Firefox Add-ons;
- Chrome Web Store;
- Edge Add-ons;
- Google Play (internal track).

It uploads the files the GitHub Release just published. Each store still reviews the
submission as usual; the job only uploads it and asks for review.

The job is `scripts/publish-stores.sh`, run once per store. A store is skipped, with a
warning, until its keys below are configured. One store failing doesn't stop the
others, but it turns the job red. Re-running the job is harmless: the stores that
already took this version reject it a second time, so those steps fail, and the
store that failed gets another try.

**First publication is manual.** None of these APIs can create a listing. Each store
needs its first version, listing, privacy answers and (Play) app content submitted in
its own console. The automation handles every update after that.

## 1. The `stores` environment (the approval step)

GitHub → repository **Settings → Environments → New environment** → name it `stores`.

- **Required reviewers:** add yourself. Every release then pauses at *Store
  submissions* until you click **Review deployments → Approve** on the run page.
- **Deployment branches and tags:** *Selected branches and tags* → add the tag rule
  `v*`.
- Add the secrets and variables below **to this environment**, not to the repository.
  Only the approved job can read them.

| Name | Kind | Store |
|---|---|---|
| `AMO_API_KEY`, `AMO_API_SECRET` | secret | Firefox |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | secret | Chrome and Play (one service account can serve both) |
| `CWS_PUBLISHER_ID`, `CWS_EXTENSION_ID` | variable | Chrome |
| `EDGE_API_KEY` | secret | Edge |
| `EDGE_CLIENT_ID`, `EDGE_PRODUCT_ID` | variable | Edge |
| `PLAY_PACKAGE_NAME` (`io.booksync.android`) | variable | Play |
| `PLAY_RELEASE_STATUS` | variable, optional | Play; see below |
| `STORE_REVIEWER_NOTES` | secret, optional | Firefox and Edge reviewer notes |

`STORE_REVIEWER_NOTES` is the reviewer text from [store-listing.md](store-listing.md):
the demo server, the test account and, for Firefox, the build steps. It holds a
password, so it is a secret. Chrome and Play keep the notes you entered in their
consoles.

## 2. Firefox Add-ons

1. Sign in at https://addons.mozilla.org/developers/addon/api/key/ (Developer Hub →
   **Tools → Manage API Keys**).
2. **Generate new credentials.**
3. Store the **JWT issuer** as `AMO_API_KEY` and the **JWT secret** as `AMO_API_SECRET`.

The job runs `web-ext sign --channel listed` with the release's
`booksync-X.Y.Z-source.tar.gz` as the source code, and doesn't wait for the review.

## 3. Google service account (Chrome and Play)

1. In https://console.cloud.google.com create a project, or pick one.
2. **APIs & Services → Library:** enable the **Chrome Web Store API** and the **Google
   Play Android Developer API**.
3. **IAM & Admin → Service accounts → Create service account.** It needs no roles in
   Google Cloud.
4. Open the account → **Keys → Add key → Create new key → JSON**. Paste the whole file
   into the `GOOGLE_SERVICE_ACCOUNT_JSON` secret, then delete the downloaded file.

The key never expires on its own. Rotate it from the same Keys page if it leaks.

## 4. Chrome Web Store

1. Chrome Web Store Developer Dashboard → **Account**: add the service account's email
   (`…@….iam.gserviceaccount.com`). The store accepts one service account per publisher.
2. `CWS_PUBLISHER_ID`: Dashboard → **Settings** (Publisher), the publisher ID.
3. `CWS_EXTENSION_ID`: the item ID shown under the name in the dashboard
   (`emdeehigeohieipgfabdigcaijhmfpdg`).

The account that owns the item needs 2-Step Verification. If you change the item's
visibility in the dashboard, publish once by hand before the API can publish again.

## 5. Edge Add-ons

1. Partner Center → **Microsoft Edge → Publish API**.
2. If asked, click **Enable** for the new experience (API keys, v1.1), then **Create
   API credentials**.
3. Store the **Client ID** as `EDGE_CLIENT_ID` and the **API key** as `EDGE_API_KEY`.
   API keys expire: the page shows the date, so renew the key and update the secret
   before then.
4. `EDGE_PRODUCT_ID`: Microsoft Edge → **Overview** → BookSync → **Product ID** (a
   GUID).

## 6. Google Play (internal track)

### First publication (once, by hand)

1. **Upload key.** Create it once and keep a backup of the file and both passwords
   outside the repository (a password manager). Losing it means asking Google for an
   upload key reset.

   ```bash
   keytool -genkeypair -v -keystore booksync-upload.jks -alias upload \
     -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=BookSync"
   ```

   Add four **repository** secrets (Settings → Secrets and variables → Actions; the
   build job is not in the `stores` environment):

   | Secret | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | `base64 -w0 booksync-upload.jks` |
   | `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
   | `ANDROID_KEY_ALIAS` | `upload` |
   | `ANDROID_KEY_PASSWORD` | the key password (with PKCS12, the same as the keystore's) |

   The next release then attaches `booksync-android-X.Y.Z.apk` and `.aab`.
2. **Developer account.** https://play.google.com/console/signup (one-time $25, plus
   identity verification, which can take a few days). An *organization* account needs
   a D-U-N-S number; a *personal* one doesn't, but see step 6.
3. **Create the app.** Play Console → **Create app**: name *BookSync*, default language
   English (United States), *App*, *Free*. Accept the declarations.
4. **Store listing and App content.** Fill them in from
   [store-listing.md](store-listing.md#google-play-android-app): texts, graphics in
   `android/store/`, privacy policy, Data safety, content rating, target audience, app
   access with the reviewer account.
5. **First upload.** **Test and release → Testing → Internal testing → Create new
   release**. Accept **Play App Signing** (Google keeps the app signing key; yours is
   the upload key). Upload the AAB from the GitHub release and roll it out. The package
   name `io.booksync.android` is fixed from now on.
6. **Production access.** A *personal* account created after November 2023 must run a
   **closed test** with at least 12 opted-in testers for 14 consecutive days before
   **Apply for production** unlocks. Create a closed testing track, add the testers'
   Google accounts (or a Google Group), promote the internal release to it, and keep
   it running. Organization accounts skip this step.
7. **Production.** **Production → Create new release**, promote the tested build and
   send it for review. The first review usually takes a few days.

Then set up the automation below; each later release reaches the internal track on
its own, and you promote it from the console.

### Automation

1. Play Console → **Users and permissions → Invite new users**: the service account's
   email.
2. Under **App permissions** add BookSync and grant **Release apps to testing tracks**.
   **Release to production** isn't needed for the internal track.
3. Set the variable `PLAY_PACKAGE_NAME` to `io.booksync.android`.
4. Android signing must be configured (`ANDROID_KEYSTORE_*` secrets, step 1 above).
   Without it the release has no AAB, and Play is skipped.

The job uploads `booksync-android-X.Y.Z.aab` to the **internal** track as a
`completed` release, so internal testers get it at once. Promote it to closed, open
or production testing from the Play Console.

**While the app has never been published,** Play accepts only draft releases. Then
the commit fails with *"Only releases with status draft may be created on draft
app."* Set the variable `PLAY_RELEASE_STATUS` to `draft` and roll each release out
from the console. Delete the variable once the app is live.

## 7. Releasing

1. Merge to `main`, then create the release `vX.Y.Z` (GitHub → Releases → *Draft a new
   release*, tag on `main`).
2. The workflow builds and tests everything and publishes the GitHub Release, then
   stops at **Store submissions**.
3. Open the run and click **Review deployments → stores → Approve and deploy**.
4. Check the job log: each store prints one line, such as *"Chrome Web Store: 1.2.0
   submitted for review"*. Then wait for the store reviews.

Each store needs a higher version than the one it has. Stores generally refuse a
version number they've already received, even one that was rejected, so fix problems
with a new patch release.

## Testing the script locally

The API addresses are overridable (`GOOGLE_TOKEN_URL`, `CWS_BASE`, `EDGE_BASE`,
`PLAY_BASE`, `WEB_EXT`), so `scripts/publish-stores.sh` can run against a local fake
server. `shellcheck scripts/publish-stores.sh` and `actionlint` check the script and the
workflow.
