// Package mobile is the gomobile facade over internal/client. This file is a
// temporary feasibility spike (plan Task 1) and is replaced in Task 11.
package mobile

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

// Ping returns a fresh GUID and the result of one HTTPS GET of url, proving
// that the internal/ import, DNS and system TLS roots work on Android.
func Ping(url string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "guid=" + vault.NewGUID() + " err=" + err.Error()
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "guid=" + vault.NewGUID() + " err=" + err.Error()
	}
	defer func() { _ = resp.Body.Close() }()
	n, _ := io.Copy(io.Discard, resp.Body)
	return fmt.Sprintf("guid=%s status=%d bytes=%d", vault.NewGUID(), resp.StatusCode, n)
}
