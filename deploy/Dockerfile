# syntax=docker/dockerfile:1
# Build context: repository root (docker build -f deploy/Dockerfile .).

# The build stage runs on the builder's own platform and cross-compiles for
# the target, so multi-arch images need no emulation.
FROM --platform=$BUILDPLATFORM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
ARG VERSION=dev
ARG TARGETOS TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
        go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" \
        -o /out/booksync-server ./cmd/booksync-server \
    && mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/booksync-server /usr/local/bin/booksync-server
# /data must exist in the image and belong to nonroot (65532): Docker copies
# this ownership into a fresh named volume, so the server can create its DB.
COPY --from=build --chown=65532:65532 /out/data /data
ENV BOOKSYNC_ADDR=:8080 \
    BOOKSYNC_DB_PATH=/data/booksync.db
VOLUME /data
EXPOSE 8080
USER nonroot:nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/usr/local/bin/booksync-server", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/booksync-server"]
