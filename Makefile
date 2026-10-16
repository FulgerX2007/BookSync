GO      ?= go
GOLANGCI_LINT ?= golangci-lint
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build run test test-go test-mobile test-ext lint fmt e2e package dist docker-smoke android-aar android-test android-apk

build:
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/booksync-server ./cmd/booksync-server

run:
	BOOKSYNC_DB_PATH=$${BOOKSYNC_DB_PATH:-./booksync.db} BOOKSYNC_LOG_LEVEL=$${BOOKSYNC_LOG_LEVEL:-debug} \
		$(GO) run ./cmd/booksync-server

test: test-go test-mobile test-ext

test-go:
	$(GO) test -race ./...

# mobile/ is a nested module (the gomobile facade); ./... at the root skips it.
test-mobile:
	cd mobile && $(GO) test -race ./...

test-ext:
	cd extension && npm run check

e2e:
	cd extension && npm run e2e

# Store-ready zips in extension/dist/packages (version from extension/package.json).
package:
	cd extension && npm run package

# Every release artifact in dist/: server archives for each OS/arch, both
# extension zips, a source archive and SHA256SUMS. `make dist VERSION=1.2.3`
# (as the release workflow runs it) stamps 1.2.3 into server and extension.
dist:
	scripts/dist.sh

docker-smoke:
	deploy/smoke.sh

lint:
	$(GOLANGCI_LINT) run ./...
	cd mobile && $(GOLANGCI_LINT) run ./...

fmt:
	gofmt -w cmd internal mobile

# Android: the Go core as an AAR, then the app. Needs the Android SDK and the
# NDK (ANDROID_HOME, ANDROID_NDK_HOME). gomobile and gobind are pinned as tools
# in mobile/go.mod and built into bin/.
GOMOBILE_BIN := $(CURDIR)/bin
ANDROID_AAR  := android/app/libs/booksync-core.aar

android-aar:
	mkdir -p $(dir $(ANDROID_AAR))
	cd mobile && GOBIN=$(GOMOBILE_BIN) $(GO) install golang.org/x/mobile/cmd/gomobile golang.org/x/mobile/cmd/gobind
	cd mobile && PATH="$(GOMOBILE_BIN):$$PATH" gomobile bind -target=android/arm64,android/amd64 -androidapi 26 \
		-javapkg io.booksync.core -trimpath -ldflags="-s -w" -o ../$(ANDROID_AAR) .

android-test: android-aar
	cd android && ./gradlew --console=plain -p buildSrc test
	cd android && ./gradlew --console=plain testDebugUnitTest lintDebug

android-apk: android-aar
	cd android && ./gradlew --console=plain assembleRelease
