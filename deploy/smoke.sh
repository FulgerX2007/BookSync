#!/usr/bin/env bash
# End-to-end check of the self-hosting bundle: builds the image, starts the
# server behind Caddy on localhost, then checks health and registration
# through TLS. Cleans up containers and volumes on exit.
# SMOKE_BUILD=0 reuses an already-built $BOOKSYNC_IMAGE instead of building.
set -euo pipefail
cd "$(dirname "$0")"

export BOOKSYNC_DOMAIN=localhost
export BOOKSYNC_HTTP_PORT="${BOOKSYNC_HTTP_PORT:-18080}"
export BOOKSYNC_HTTPS_PORT="${BOOKSYNC_HTTPS_PORT:-18443}"
project="booksync-smoke-$$"

compose() { docker compose -p "$project" -f docker-compose.yml "$@"; }
cleanup() {
	status=$?
	if [ "$status" -ne 0 ]; then
		echo "--- smoke test failed; container logs:" >&2
		compose logs --no-color >&2 || true
	fi
	compose down -v --remove-orphans >/dev/null 2>&1 || true
	exit "$status"
}
trap cleanup EXIT

b64url() { head -c "$1" /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_'; }

build_flag=--build
[ "${SMOKE_BUILD:-1}" = 0 ] && build_flag=--no-build
compose up -d "$build_flag" --wait --wait-timeout 180

base="https://localhost:${BOOKSYNC_HTTPS_PORT}"
for _ in $(seq 1 30); do
	curl --noproxy "*" -fsSk "$base/healthz" >/dev/null && break
	sleep 1
done
curl --noproxy "*" -fsSk "$base/healthz" | grep -q '"ok"'
curl --noproxy "*" -fsSk "$base/v1/info" | grep -q '"service":"booksync"'
curl --noproxy "*" -fsSk "$base/" | grep -q 'class="pill ok">Online<'

user="smoke$RANDOM"
body=$(printf '{"username":"%s","authKey":"%s","kdf":"pbkdf2-sha256","iterations":600000,"wrappedVaultKey":"%s","deviceName":"smoke"}' \
	"$user" "$(b64url 32)" "$(b64url 60)")
resp=$(curl --noproxy "*" -fsSk -X POST "$base/v1/auth/register" -H 'Content-Type: application/json' -d "$body")
echo "$resp" | grep -q '"deviceToken":"bst_'

echo "smoke test passed: $base"
