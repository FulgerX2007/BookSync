package crypto

import (
	"bytes"
	"encoding/hex"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/client/conformance"
)

type syncIDInput struct {
	Op    string `json:"op"`
	Bytes string `json:"bytes"`
	Text  string `json:"text"`
}

type syncIDExpected struct {
	Text  string `json:"text"`
	Bytes string `json:"bytes"`
	Error string `json:"error"`
}

func TestSyncIDConformance(t *testing.T) {
	for _, c := range conformance.Load[syncIDInput, syncIDExpected](t, "syncid.json") {
		t.Run(c.Name, func(t *testing.T) {
			switch c.Input.Op {
			case "format":
				got, err := FormatSyncID(unhex(t, c.Input.Bytes))
				if err != nil || got != c.Expected.Text {
					t.Fatalf("FormatSyncID = %q, %v; want %q", got, err, c.Expected.Text)
				}
			case "parse":
				got, err := ParseSyncID(c.Input.Text)
				if c.Expected.Error != "" {
					if CodeOf(err) != c.Expected.Error {
						t.Fatalf("ParseSyncID(%q) err = %v, want %s", c.Input.Text, err, c.Expected.Error)
					}
					return
				}
				if err != nil || hex.EncodeToString(got) != c.Expected.Bytes {
					t.Fatalf("ParseSyncID(%q) = %x, %v; want %s", c.Input.Text, got, err, c.Expected.Bytes)
				}
			default:
				t.Fatalf("unknown op %q", c.Input.Op)
			}
		})
	}
}

func TestSyncIDRoundTrip(t *testing.T) {
	for range 200 {
		id := NewSyncID()
		text, err := FormatSyncID(id)
		if err != nil {
			t.Fatal(err)
		}
		got, err := ParseSyncID(text)
		if err != nil || !bytes.Equal(got, id) {
			t.Fatalf("round trip of %x via %s: %x, %v", id, text, got, err)
		}
	}
	if _, err := FormatSyncID(make([]byte, 15)); CodeOf(err) != CodeInvalidFormat {
		t.Fatalf("15 bytes: %v", err)
	}
}

func TestParseSyncIDIgnoresUnicodeSpace(t *testing.T) {
	text, _ := FormatSyncID(make([]byte, 16))
	if _, err := ParseSyncID("\uFEFF " + text + "\u00a0"); err != nil {
		t.Fatal(err)
	}
}
