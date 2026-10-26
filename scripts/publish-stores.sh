#!/usr/bin/env bash
# Submits a release to one store. The release workflow's `stores` job runs it
# once per configured store (docs/store-publishing.md explains the setup).
#
#   scripts/publish-stores.sh firefox|chrome|edge|play
#
# Inputs come from the environment:
#   VERSION                        release version (X.Y.Z)
#   DIST                           directory holding the release files (default dist)
#   STORE_REVIEWER_NOTES           optional; sent to AMO and Edge reviewers
#   firefox: AMO_API_KEY, AMO_API_SECRET
#   chrome:  GOOGLE_SERVICE_ACCOUNT_JSON, CWS_PUBLISHER_ID, CWS_EXTENSION_ID
#   edge:    EDGE_CLIENT_ID, EDGE_API_KEY, EDGE_PRODUCT_ID
#   play:    GOOGLE_SERVICE_ACCOUNT_JSON, PLAY_PACKAGE_NAME,
#            PLAY_TRACK (default internal), PLAY_RELEASE_STATUS (default completed)
#
# Every store reviews the submission; this only uploads it and asks for review.
# The *_BASE variables exist so the script can be run against a local fake.
set -euo pipefail

: "${VERSION:?VERSION is required}"
DIST="${DIST:-dist}"
POLL_SECONDS="${POLL_SECONDS:-10}"
POLL_TRIES="${POLL_TRIES:-60}"

GOOGLE_TOKEN_URL="${GOOGLE_TOKEN_URL:-https://oauth2.googleapis.com/token}"
CWS_BASE="${CWS_BASE:-https://chromewebstore.googleapis.com}"
EDGE_BASE="${EDGE_BASE:-https://api.addons.microsoftedge.microsoft.com}"
PLAY_BASE="${PLAY_BASE:-https://androidpublisher.googleapis.com}"
WEB_EXT="${WEB_EXT:-extension/node_modules/.bin/web-ext}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

die() {
  echo "::error::$*" >&2
  exit 1
}

need() {
  local v
  for v in "$@"; do
    [[ -n "${!v:-}" ]] || die "$v is not set"
  done
}

file() {
  [[ -f "$DIST/$1" ]] || die "$DIST/$1 is missing"
  printf '%s' "$DIST/$1"
}

# curl that prints the response body, and on an HTTP error fails with the
# body on stderr, where the job log shows it.
http() {
  local out="$work/http-body" rc=0
  curl -sS --fail-with-body --retry 3 --retry-connrefused --max-time 600 -o "$out" "$@" || rc=$?
  if ((rc != 0)); then
    echo "response: $(head -c 4000 "$out" 2>/dev/null)" >&2
    return "$rc"
  fi
  cat "$out"
}

b64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

# An OAuth access token for the service account in GOOGLE_SERVICE_ACCOUNT_JSON
# (JWT bearer grant, RFC 7523), for scope $1.
google_token() {
  local scope="$1" email key header claims now sig
  email="$(jq -er .client_email <<<"$GOOGLE_SERVICE_ACCOUNT_JSON")" || die "GOOGLE_SERVICE_ACCOUNT_JSON has no client_email"
  key="$work/sa.pem"
  (umask 077 && jq -er .private_key <<<"$GOOGLE_SERVICE_ACCOUNT_JSON" >"$key") || die "GOOGLE_SERVICE_ACCOUNT_JSON has no private_key"
  now="$(date +%s)"
  header="$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | b64url)"
  claims="$(jq -nc --arg iss "$email" --arg scope "$scope" --arg aud "$GOOGLE_TOKEN_URL" --argjson iat "$now" \
    '{iss: $iss, scope: $scope, aud: $aud, iat: $iat, exp: ($iat + 3600)}' | b64url)"
  sig="$(printf '%s.%s' "$header" "$claims" | openssl dgst -sha256 -sign "$key" | b64url)"
  rm -f "$key"
  http -X POST "$GOOGLE_TOKEN_URL" \
    --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer' \
    --data-urlencode "assertion=$header.$claims.$sig" | jq -er .access_token
}

firefox() {
  need AMO_API_KEY AMO_API_SECRET
  local zip src dir args
  zip="$(file "booksync-firefox-$VERSION.zip")"
  src="$(file "booksync-$VERSION-source.tar.gz")"
  [[ -x "$WEB_EXT" ]] || die "$WEB_EXT not found; run npm ci in extension/"
  dir="$work/firefox"
  mkdir -p "$dir"
  unzip -q "$zip" -d "$dir"
  # The add-on id comes from the manifest; the listing and license stay as they are on AMO.
  args=(sign --source-dir "$dir" --artifacts-dir "$work/artifacts" --channel listed
    --upload-source-code "$src" --approval-timeout 0 --no-input)
  if [[ -n "${STORE_REVIEWER_NOTES:-}" ]]; then
    jq -n --arg notes "$STORE_REVIEWER_NOTES" '{version: {approval_notes: $notes}}' >"$work/amo-metadata.json"
    args+=(--amo-metadata "$work/amo-metadata.json")
  fi
  WEB_EXT_API_KEY="$AMO_API_KEY" WEB_EXT_API_SECRET="$AMO_API_SECRET" "$WEB_EXT" "${args[@]}"
  echo "Firefox: $VERSION submitted to AMO for review."
}

chrome() {
  need GOOGLE_SERVICE_ACCOUNT_JSON CWS_PUBLISHER_ID CWS_EXTENSION_ID
  local zip token item res state i
  zip="$(file "booksync-chromium-$VERSION.zip")"
  token="$(google_token https://www.googleapis.com/auth/chromewebstore)"
  item="publishers/$CWS_PUBLISHER_ID/items/$CWS_EXTENSION_ID"
  res="$(http -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/zip' \
    -T "$zip" "$CWS_BASE/upload/v2/$item:upload")"
  state="$(jq -r '.uploadState // empty' <<<"$res")"
  for ((i = 0; i < POLL_TRIES; i++)); do
    [[ "$state" == IN_PROGRESS || "$state" == UPLOAD_IN_PROGRESS ]] || break
    sleep "$POLL_SECONDS"
    res="$(http -H "Authorization: Bearer $token" "$CWS_BASE/v2/$item:fetchStatus")"
    state="$(jq -r '.lastAsyncUploadState // empty' <<<"$res")"
  done
  [[ "$state" == SUCCEEDED ]] || die "Chrome Web Store upload ended in state '${state:-none}': $res"
  res="$(http -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d '{}' "$CWS_BASE/v2/$item:publish")"
  echo "Chrome Web Store: $VERSION submitted for review (state $(jq -r '.state // "unknown"' <<<"$res"))."
}

# POSTs to an Edge endpoint that answers 202 + Location, then polls
# $1/operations/<id> until the operation leaves InProgress.
edge_operation() {
  local url="$1" headers op res status i
  shift
  headers="$work/edge-headers"
  http -X POST -D "$headers" -H "Authorization: ApiKey $EDGE_API_KEY" \
    -H "X-ClientID: $EDGE_CLIENT_ID" "$@" "$url" >/dev/null
  op="$(tr -d '\r' <"$headers" | awk 'tolower($1) == "location:" { print $2 }' | tail -n 1)"
  op="${op##*/}"
  [[ -n "$op" ]] || die "Edge returned no operation id for $url"
  for ((i = 0; i < POLL_TRIES; i++)); do
    res="$(http -H "Authorization: ApiKey $EDGE_API_KEY" -H "X-ClientID: $EDGE_CLIENT_ID" "$url/operations/$op")"
    status="$(jq -r '.status // empty' <<<"$res")"
    [[ "$status" == InProgress ]] || break
    sleep "$POLL_SECONDS"
  done
  [[ "$status" == Succeeded ]] || die "Edge operation $op ended as '${status:-unknown}': $res"
  printf '%s' "$res"
}

edge() {
  need EDGE_CLIENT_ID EDGE_API_KEY EDGE_PRODUCT_ID
  local zip product notes
  zip="$(file "booksync-chromium-$VERSION.zip")"
  product="$EDGE_BASE/v1/products/$EDGE_PRODUCT_ID/submissions"
  edge_operation "$product/draft/package" -H 'Content-Type: application/zip' -T "$zip" >/dev/null
  notes="$(jq -n --arg notes "${STORE_REVIEWER_NOTES:-BookSync $VERSION}" '{notes: $notes}')"
  edge_operation "$product" -H 'Content-Type: application/json' -d "$notes" >/dev/null
  echo "Edge Add-ons: $VERSION submitted for certification."
}

play() {
  need GOOGLE_SERVICE_ACCOUNT_JSON PLAY_PACKAGE_NAME
  local aab token app edit code track status release
  aab="$(file "booksync-android-$VERSION.aab")"
  track="${PLAY_TRACK:-internal}"
  status="${PLAY_RELEASE_STATUS:-completed}"
  token="$(google_token https://www.googleapis.com/auth/androidpublisher)"
  app="applications/$PLAY_PACKAGE_NAME"
  edit="$(http -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{}' \
    "$PLAY_BASE/androidpublisher/v3/$app/edits" | jq -er .id)"
  code="$(http -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/octet-stream' \
    --data-binary "@$aab" "$PLAY_BASE/upload/androidpublisher/v3/$app/edits/$edit/bundles?uploadType=media" |
    jq -er .versionCode)"
  release="$(jq -n --arg track "$track" --arg name "$VERSION" --arg code "$code" --arg status "$status" \
    '{track: $track, releases: [{name: $name, versionCodes: [$code], status: $status}]}')"
  http -X PUT -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$release" \
    "$PLAY_BASE/androidpublisher/v3/$app/edits/$edit/tracks/$track" >/dev/null
  http -X POST -H "Authorization: Bearer $token" "$PLAY_BASE/androidpublisher/v3/$app/edits/$edit:commit" >/dev/null
  echo "Google Play: $VERSION (versionCode $code) released to the $track track as $status."
}

case "${1:-}" in
  firefox | chrome | edge | play) "$1" ;;
  *) die "usage: $0 firefox|chrome|edge|play" ;;
esac
