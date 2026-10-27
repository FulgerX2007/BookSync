#!/usr/bin/env bash
# Builds every release artifact into dist/:
#   booksync-server_<version>_<os>_<arch>.tar.gz   (.zip for Windows)
#   booksync-chromium-<version>.zip, booksync-firefox-<version>.zip
#   booksync-<version>-source.tar.gz               (git archive of HEAD, e.g. for AMO review)
#   SHA256SUMS
#
# VERSION defaults to `git describe`; a leading "v" is dropped. For a release
# version (X.Y.Z or X.Y.Z-suffix, e.g. from the tag) the extension gets X.Y.Z,
# since browser stores accept only plain numbers; other versions (a bare
# commit hash) fall back to extension/package.json's.
set -euo pipefail
cd "$(dirname "$0")/.."

version="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
version="${version#v}"
if [[ "$version" =~ ^([0-9]+\.[0-9]+\.[0-9]+)(-[0-9A-Za-z.-]+)?$ ]]; then
	ext_version="${BASH_REMATCH[1]}"
else
	ext_version="$(node -p 'require("./extension/package.json").version')"
fi

targets=(linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64)
out="$PWD/dist"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
rm -rf "$out"
mkdir -p "$out"

for t in "${targets[@]}"; do
	os="${t%/*}" arch="${t#*/}"
	name="booksync-server_${version}_${os}_${arch}"
	exe=booksync-server
	[[ "$os" == windows ]] && exe+=.exe
	mkdir -p "$work/$name"
	echo "building $name"
	CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "-s -w -X main.version=$version" \
		-o "$work/$name/$exe" ./cmd/booksync-server
	cp README.md "$work/$name/"
	cp docs/self-hosting.md "$work/$name/SELF-HOSTING.md"
	if [[ "$os" == windows ]]; then
		(cd "$work" && zip -qr "$out/$name.zip" "$name")
	else
		tar -C "$work" -czf "$out/$name.tar.gz" "$name"
	fi
done

[[ -d extension/node_modules ]] || (cd extension && npm ci --no-audit --no-fund)
(cd extension && BOOKSYNC_VERSION="$ext_version" npm run package)
cp extension/dist/packages/booksync-{chromium,firefox}-"$ext_version".zip "$out/"

git archive --format=tar.gz --prefix="booksync-$version/" -o "$out/booksync-$version-source.tar.gz" HEAD

(cd "$out" && sha256sum -- * >SHA256SUMS)
echo "artifacts in dist/:"
ls -1 "$out"
