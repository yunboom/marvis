package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yunboom/marvis/server/internal/cli"
	"github.com/yunboom/marvis/server/internal/knowledge"
)

func TestCommitAndPushCreatesKnowledgeBranchWithoutPersistingCredentials(t *testing.T) {
	ws := "11111111-2222-3333-4444-555555555555"
	store, err := knowledge.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := store.Ensure(ctx, ws); err != nil {
		t.Fatal(err)
	}
	head, _ := store.Head(ctx, ws)
	if _, err := store.Commit(ctx, ws, knowledge.MainRef, head, head, "seed", knowledge.Signature{}, []knowledge.FileChange{{Path: "team/index.md", Content: []byte("# team\n")}}); err != nil {
		t.Fatal(err)
	}

	dir := filepath.Join(t.TempDir(), "clone")
	if out, err := exec.Command("git", "clone", "-q", store.RepoDir(ws), dir).CombinedOutput(); err != nil {
		t.Fatalf("clone: %v %s", err, out)
	}
	if err := os.WriteFile(filepath.Join(dir, "team", "index.md"), []byte("# team\n\n- new page\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	client := &cli.APIClient{Token: "secret-token", WorkspaceID: ws}
	branch, err := commitAndPush(client, dir, "Add page", false)
	if err != nil {
		t.Fatalf("commitAndPush: %v", err)
	}
	if !strings.HasPrefix(branch, kbBranchPrefix) {
		t.Fatalf("branch = %q, want kb/ prefix", branch)
	}
	if _, err := store.Resolve(ctx, ws, knowledge.BranchRef(branch)); err != nil {
		t.Fatalf("pushed branch missing on remote: %v", err)
	}
	if h, _ := store.Head(ctx, ws); h == "" {
		t.Fatal("main vanished")
	}

	config, err := os.ReadFile(filepath.Join(dir, ".git", "config"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(config), "secret-token") {
		t.Fatalf("credentials written into the clone config:\n%s", config)
	}

	// A second call on the same branch pushes again instead of opening another branch.
	if err := os.WriteFile(filepath.Join(dir, "team", "index.md"), []byte("# team\n\n- newer page\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	again, err := commitAndPush(client, dir, "", true)
	if err != nil || again != branch {
		t.Fatalf("second push = %q %v, want %q", again, err, branch)
	}
}
