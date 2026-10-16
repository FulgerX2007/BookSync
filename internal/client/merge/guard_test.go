package merge

import (
	"encoding/json"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/client/conformance"
)

type guardInput struct {
	Op            string          `json:"op"`
	Local         json.RawMessage `json:"local"`
	Remote        json.RawMessage `json:"remote"`
	Merged        json.RawMessage `json:"merged"`
	RemoteVersion *int64          `json:"remoteVersion"`
	Confirmed     *Pending        `json:"confirmed"`
	Pending       *Pending        `json:"pending"`
}

type guardExpected struct {
	Pending *Pending `json:"pending"`
	Covers  bool     `json:"covers"`
}

func TestGuardConformance(t *testing.T) {
	for _, c := range conformance.Load[guardInput, guardExpected](t, "guard.json") {
		t.Run(c.Name, func(t *testing.T) {
			in := c.Input
			switch in.Op {
			case "check":
				got := Guard(parse(t, in.Local), parse(t, in.Remote), parse(t, in.Merged), in.RemoteVersion)
				gj, _ := json.Marshal(got)
				wj, _ := json.Marshal(c.Expected.Pending)
				if string(gj) != string(wj) {
					t.Fatalf("Guard = %s, want %s", gj, wj)
				}
			case "covers":
				if got := Covers(in.Confirmed, in.Pending); got != c.Expected.Covers {
					t.Fatalf("Covers = %v", got)
				}
			default:
				t.Fatalf("unknown op %q", in.Op)
			}
		})
	}
}

func TestCoversNilVersions(t *testing.T) {
	v := int64(3)
	p := &Pending{RemoteVersion: &v, DeletionsToLocal: 20}
	if Covers(&Pending{DeletionsToLocal: 20}, p) || Covers(p, &Pending{DeletionsToLocal: 20}) {
		t.Fatal("a nil version must only match nil")
	}
}
