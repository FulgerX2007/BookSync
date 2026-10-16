package main

import (
	"bytes"
	"context"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

func testEnv(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

// readyLog is run's log output; ready closes once the server logs that it is
// listening, so a test cancels only after startup (store open, migrations) is done.
type readyLog struct {
	mu    sync.Mutex
	buf   bytes.Buffer
	once  sync.Once
	ready chan struct{}
}

func (l *readyLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.buf.Write(p)
	if strings.Contains(l.buf.String(), `"msg":"listening"`) {
		l.once.Do(func() { close(l.ready) })
	}
	return len(p), nil
}

func TestRunShutsDownOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	logs := &readyLog{ready: make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, testEnv(map[string]string{
			"BOOKSYNC_ADDR":    "127.0.0.1:0",
			"BOOKSYNC_DB_PATH": t.TempDir() + "/booksync.db",
		}), logs)
	}()
	select {
	case <-logs.ready:
	case err := <-done:
		t.Fatalf("run returned before listening: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("run did not start listening")
	}
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
