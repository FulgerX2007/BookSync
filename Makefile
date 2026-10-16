GO      ?= go
GOLANGCI_LINT ?= golangci-lint
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build run test test-go test-ext lint fmt e2e e2e-edge package dist docker-smoke

build:
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/booksync-server ./cmd/booksync-server

run:
	BOOKSYNC_DB_PATH=$${BOOKSYNC_DB_PATH:-./booksync.db} BOOKSYNC_LOG_LEVEL=$${BOOKSYNC_LOG_LEVEL:-debug} \
		$(GO) run ./cmd/booksync-server

test: test-go test-ext

test-go:
	$(GO) test -race ./...

test-ext:
	cd extension && npm run check

e2e:
	cd extension && npm run e2e

# The same e2e suite in the installed Microsoft Edge (stable channel).
e2e-edge:
	cd extension && BOOKSYNC_E2E_BROWSER=msedge npm run e2e

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

fmt:
	gofmt -w cmd internal
