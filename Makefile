GO      ?= go
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build run test test-go lint fmt

build:
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/booksync-server ./cmd/booksync-server

run:
	BOOKSYNC_DB_PATH=$${BOOKSYNC_DB_PATH:-./booksync.db} BOOKSYNC_LOG_LEVEL=$${BOOKSYNC_LOG_LEVEL:-debug} \
		$(GO) run ./cmd/booksync-server

test: test-go

test-go:
	$(GO) test -race ./...

lint:
	golangci-lint run ./...

fmt:
	gofmt -w cmd internal
