// Package conformance loads the golden corpus in testdata/conformance, which
// the TS reference client generates (extension/test/conformance). Go tests
// replay it so both clients compute the same results.
package conformance

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Case is one corpus entry; Input and Expected are decoded per file.
type Case[I, E any] struct {
	Name     string `json:"name"`
	Input    I      `json:"input"`
	Expected E      `json:"expected"`
}

type file[I, E any] struct {
	Generator string       `json:"generator"`
	Seed      int64        `json:"seed"`
	Cases     []Case[I, E] `json:"cases"`
}

// Dir is the absolute path of testdata/conformance.
func Dir() string {
	_, self, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(self), "..", "..", "..", "testdata", "conformance")
}

// Load reads one corpus file and fails the test if it is missing or empty.
func Load[I, E any](t testing.TB, name string) []Case[I, E] {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(Dir(), name)) //nolint:gosec // test helper; name is a corpus file chosen by the test
	if err != nil {
		t.Fatalf("conformance: %v (run npm run conformance:gen in extension/)", err)
	}
	var f file[I, E]
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("conformance: %s: %v", name, err)
	}
	if len(f.Cases) == 0 {
		t.Fatalf("conformance: %s has no cases", name)
	}
	return f.Cases
}

// Write renders cases in the corpus layout (one case per line) to name. It
// is used by Go tests run with -update to produce fixtures for the TS side.
func Write[I, E any](t testing.TB, name, generator string, cases []Case[I, E]) {
	t.Helper()
	out := []byte(`{"generator":` + quote(generator) + `,"seed":0,"cases":[` + "\n")
	for i, c := range cases {
		line, err := json.Marshal(c)
		if err != nil {
			t.Fatalf("conformance: %v", err)
		}
		out = append(out, line...)
		if i < len(cases)-1 {
			out = append(out, ',')
		}
		out = append(out, '\n')
	}
	out = append(out, "]}\n"...)
	if err := os.WriteFile(filepath.Join(Dir(), name), out, 0o644); err != nil { //nolint:gosec // test fixture, world-readable on purpose
		t.Fatalf("conformance: %v", err)
	}
}

func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
