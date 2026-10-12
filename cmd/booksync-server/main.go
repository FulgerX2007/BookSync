// Command booksync-server runs the BookSync sync server.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/FulgerX2007/BookSync/internal/api"
	"github.com/FulgerX2007/BookSync/internal/auth"
	"github.com/FulgerX2007/BookSync/internal/config"
	"github.com/FulgerX2007/BookSync/internal/store"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cmd := run
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		cmd = func(ctx context.Context, getenv func(string) string, _ io.Writer) error {
			return healthcheck(ctx, getenv)
		}
	}
	if err := cmd(ctx, os.Getenv, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "booksync-server:", err)
		stop()
		os.Exit(1)
	}
}

// run starts the server and blocks until ctx is cancelled or serving fails.
func run(ctx context.Context, getenv func(string) string, logOut io.Writer) error {
	cfg, err := config.Load(getenv)
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	logHandler := slog.NewJSONHandler(logOut, &slog.HandlerOptions{Level: cfg.LogLevel})
	log := slog.New(logHandler)

	st, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.NewServer(cfg, api.Deps{Logger: log, Store: st, Hasher: auth.NewHasher(4)}),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(logHandler, slog.LevelWarn),
	}

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	log.Info("listening", "addr", cfg.Addr, "version", version)

	select {
	case err := <-errCh:
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
	}

	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	if err := <-errCh; !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve: %w", err)
	}
	return nil
}
