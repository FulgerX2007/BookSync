package main

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

func testEnv(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

func TestRunShutsDownOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, testEnv(map[string]string{
			"BOOKSYNC_ADDR":    "127.0.0.1:0",
			"BOOKSYNC_DB_PATH": t.TempDir() + "/booksync.db",
		}), io.Discard)
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("run did not return after cancel")
	}
}

func TestRunRejectsInvalidConfig(t *testing.T) {
	err := run(context.Background(), testEnv(map[string]string{"BOOKSYNC_TOKEN_TTL": "soon"}), io.Discard)
	if err == nil || !strings.Contains(err.Error(), "config") {
		t.Fatalf("err = %v, want config error", err)
	}
}
