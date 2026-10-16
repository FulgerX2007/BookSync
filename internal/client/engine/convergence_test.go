package engine

import (
	"fmt"
	"math/rand/v2"
	"os"
	"strconv"
	"testing"

	"github.com/FulgerX2007/BookSync/internal/client/ops"
	"github.com/FulgerX2007/BookSync/internal/client/testserver"
	"github.com/FulgerX2007/BookSync/internal/client/vault"
)

// rounds of random edits and syncs; BOOKSYNC_PROP_RUNS scales it (default 200
// runs ≈ 60 rounds here, since every round makes real HTTP calls).
func rounds(t *testing.T) int {
	t.Helper()
	n := 200
	if s := os.Getenv("BOOKSYNC_PROP_RUNS"); s != "" {
		var err error
		if n, err = strconv.Atoi(s); err != nil {
			t.Fatal(err)
		}
	}
	return max(n*3/10, 10)
}

// randomEdit applies one random edit through the same ops the UI uses.
func randomEdit(r *rand.Rand, d *vault.Doc) error {
	var folders, nodes []vault.GUID
	for _, g := range vault.SortedGUIDs(d.Nodes) {
		if d.Nodes[g].Kind == vault.Folder {
			folders = append(folders, g)
		}
		if !vault.IsRoot(g) {
			nodes = append(nodes, g)
		}
	}
	pos := func(parent vault.GUID) ops.Position {
		kids := d.Nodes[parent].Children
		if i := r.IntN(len(kids) + 1); i < len(kids) {
			return ops.After(kids[i])
		}
		return ops.First
	}
	parent := folders[r.IntN(len(folders))]
	switch op := r.IntN(10); {
	case op < 3 || len(nodes) == 0:
		_, err := ops.AddBookmark(d, parent, pos(parent), fmt.Sprintf("t%d", r.IntN(6)), fmt.Sprintf("https://u%d.example/", r.IntN(6)))
		return err
	case op < 5:
		_, err := ops.AddFolder(d, parent, pos(parent), fmt.Sprintf("t%d", r.IntN(6)))
		return err
	case op < 7:
		return ops.Rename(d, nodes[r.IntN(len(nodes))], fmt.Sprintf("t%d", r.IntN(6)))
	case op < 9:
		err := ops.Move(d, nodes[r.IntN(len(nodes))], parent, pos(parent))
		if ops.CodeOf(err) == ops.CodeInvalidMove {
			return nil
		}
		return err
	default:
		return ops.Delete(d, nodes[r.IntN(len(nodes))])
	}
}

// syncUntilSettled answers guard prompts like a user who confirms, and
// reports anything else that is not ok.
func syncUntilSettled(t *testing.T, d *device) {
	t.Helper()
	r := d.Sync(ctx, SyncOptions{})
	if r.Status == StatusNeedsConfirmation {
		r = d.ConfirmDeletions(ctx)
	}
	if r.Status != StatusOK {
		t.Fatalf("Sync = %+v", r)
	}
}

// Three devices edit randomly and sync in random order; once everyone has
// synced twice without edits, all devices and the server hold the same tree
// and a further round uploads nothing.
func TestConvergenceProperty(t *testing.T) {
	t.Parallel()
	srv := testserver.Start(t)
	devs := []*device{newDevice(t, "d0"), newDevice(t, "d1"), newDevice(t, "d2")}
	kit := mustRegister(t, devs[0], srv.URL, "alice")
	syncUntilSettled(t, devs[0])
	for _, d := range devs[1:] {
		mustLogin(t, d, srv.URL, "alice", kit.SyncID)
		syncUntilSettled(t, d)
	}

	r := rand.New(rand.NewPCG(20261016, 9))
	for round := range rounds(t) {
		d := devs[r.IntN(len(devs))]
		for range r.IntN(4) {
			if err := d.Edit(func(doc *vault.Doc) error { return randomEdit(r, doc) }); err != nil {
				t.Fatalf("round %d: edit: %v", round, err)
			}
		}
		if r.IntN(3) > 0 {
			syncUntilSettled(t, d)
		}
	}
	for range 2 {
		for _, d := range devs {
			syncUntilSettled(t, d)
		}
	}
	server, _ := serverDoc(t, srv, devs[0])
	for i, d := range devs {
		if !vault.Equal(d.Tree(), server) {
			t.Fatalf("device %d diverged from the server", i)
		}
		puts := d.net.Count[putVault]
		syncUntilSettled(t, d)
		if d.net.Count[putVault] != puts {
			t.Fatalf("device %d uploaded after convergence", i)
		}
	}
	if vs := vault.Validate(server); len(vs) > 0 {
		t.Fatalf("server tree invalid: %v", vs)
	}
}
