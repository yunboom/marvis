package knowledge

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const testWorkspace = "11111111-2222-3333-4444-555555555555"

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if err := s.Ensure(context.Background(), testWorkspace); err != nil {
		t.Fatalf("Ensure: %v", err)
	}

	return s
}

func mustCommit(t *testing.T, s *Store, ref, parent, expectOld string, changes ...FileChange) string {
	t.Helper()
	c, err := s.Commit(context.Background(), testWorkspace, ref, parent, expectOld, "test", Signature{Name: "Tester"}, changes)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}

	return c
}

func TestEnsureIsIdempotentAndStartsWithEmptyMain(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	if err := s.Ensure(ctx, testWorkspace); err != nil {
		t.Fatalf("second Ensure: %v", err)
	}

	head, err := s.Head(ctx, testWorkspace)
	if err != nil {
		t.Fatalf("Head: %v", err)
	}
	files, err := s.ListFiles(ctx, testWorkspace, head, "")
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("fresh repo files = %v, want none", files)
	}
}

func TestCommitWritesAndDeletesFiles(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	head, _ := s.Head(ctx, testWorkspace)

	c1 := mustCommit(t, s, MainRef, head, head,
		FileChange{Path: "team/a.md", Content: []byte("A")},
		FileChange{Path: "team/b.md", Content: []byte("B")},
	)
	c2 := mustCommit(t, s, MainRef, c1, c1, FileChange{Path: "team/a.md", Delete: true})

	files, _ := s.ListFiles(ctx, testWorkspace, c2, "team")
	if strings.Join(files, ",") != "team/b.md" {
		t.Fatalf("files after delete = %v", files)
	}
	got, err := s.ReadFiles(ctx, testWorkspace, c2, []string{"team/b.md", "team/a.md"})
	if err != nil {
		t.Fatalf("ReadFiles: %v", err)
	}
	if string(got["team/b.md"]) != "B" {
		t.Fatalf("b.md = %q", got["team/b.md"])
	}
	if _, ok := got["team/a.md"]; ok {
		t.Fatalf("deleted file still readable")
	}
	if _, err := s.ReadFile(ctx, testWorkspace, c2, "team/a.md"); err != ErrNotFound {
		t.Fatalf("ReadFile deleted = %v, want ErrNotFound", err)
	}
}

func TestCommitRejectsStaleParentRef(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	head, _ := s.Head(ctx, testWorkspace)
	mustCommit(t, s, MainRef, head, head, FileChange{Path: "x.md", Content: []byte("1")})

	_, err := s.Commit(ctx, testWorkspace, MainRef, head, head, "stale", Signature{}, []FileChange{{Path: "y.md", Content: []byte("2")}})
	if err != ErrRefMoved {
		t.Fatalf("stale commit err = %v, want ErrRefMoved", err)
	}
}

func TestCommitRejectsEscapingPaths(t *testing.T) {
	s := newTestStore(t)
	head, _ := s.Head(context.Background(), testWorkspace)
	for _, p := range []string{"../x", "/abs", "a/../../b", ""} {
		if _, err := s.Commit(context.Background(), testWorkspace, MainRef, head, head, "bad", Signature{}, []FileChange{{Path: p, Content: []byte("x")}}); err == nil {
			t.Fatalf("path %q accepted", p)
		}
	}
}

func TestMergeDetectsConflictsThenMerges(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	head, _ := s.Head(ctx, testWorkspace)
	base := mustCommit(t, s, MainRef, head, head, FileChange{Path: "team/p.md", Content: []byte("line1\nline2\n")})

	clean := mustCommit(t, s, BranchRef("kb/clean"), base, "", FileChange{Path: "team/q.md", Content: []byte("new\n")})
	conflicting := mustCommit(t, s, BranchRef("kb/conflict"), base, "", FileChange{Path: "team/p.md", Content: []byte("branch\nline2\n")})
	mainMoved := mustCommit(t, s, MainRef, base, base, FileChange{Path: "team/p.md", Content: []byte("main\nline2\n")})

	res, err := s.TryMerge(ctx, testWorkspace, mainMoved, conflicting)
	if err != nil {
		t.Fatalf("TryMerge: %v", err)
	}
	if strings.Join(res.Conflicts, ",") != "team/p.md" {
		t.Fatalf("conflicts = %v, want team/p.md", res.Conflicts)
	}
	if _, conflicts, err := s.Merge(ctx, testWorkspace, conflicting, "merge", Signature{}); err != nil || len(conflicts) != 1 {
		t.Fatalf("Merge conflicting = %v %v", conflicts, err)
	}
	if h, _ := s.Head(ctx, testWorkspace); h != mainMoved {
		t.Fatalf("conflicting merge moved main")
	}

	merged, conflicts, err := s.Merge(ctx, testWorkspace, clean, "merge clean", Signature{})
	if err != nil || len(conflicts) != 0 {
		t.Fatalf("Merge clean = %v %v", conflicts, err)
	}
	got, _ := s.ReadFiles(ctx, testWorkspace, merged, []string{"team/p.md", "team/q.md"})
	if string(got["team/p.md"]) != "main\nline2\n" || string(got["team/q.md"]) != "new\n" {
		t.Fatalf("merged contents = %q", got)
	}
}

func TestRevertUndoesMergedCommitOnNewBranch(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	head, _ := s.Head(ctx, testWorkspace)
	base := mustCommit(t, s, MainRef, head, head, FileChange{Path: "team/p.md", Content: []byte("old\n")})
	branch := mustCommit(t, s, BranchRef("kb/edit"), base, "", FileChange{Path: "team/p.md", Content: []byte("new\n")})
	merged, _, err := s.Merge(ctx, testWorkspace, branch, "merge", Signature{})
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}

	reverted, conflicts, err := s.Revert(ctx, testWorkspace, merged, "kb/revert-1", "revert", Signature{})
	if err != nil || len(conflicts) != 0 {
		t.Fatalf("Revert = %v %v", conflicts, err)
	}
	got, _ := s.ReadFile(ctx, testWorkspace, reverted, "team/p.md")
	if string(got) != "old\n" {
		t.Fatalf("reverted content = %q", got)
	}
	if h, _ := s.Head(ctx, testWorkspace); h != merged {
		t.Fatalf("revert moved main")
	}
}

func TestDiffReportsLineNumbers(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	head, _ := s.Head(ctx, testWorkspace)
	a := mustCommit(t, s, MainRef, head, head, FileChange{Path: "team/p.md", Content: []byte("one\ntwo\nthree\n")})
	b := mustCommit(t, s, MainRef, a, a, FileChange{Path: "team/p.md", Content: []byte("one\n2\nthree\n")}, FileChange{Path: "team/n.md", Content: []byte("n\n")})

	files, err := s.Diff(ctx, testWorkspace, a, b)
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("diff files = %+v", files)
	}
	var p FileDiff
	for _, f := range files {
		if f.Path == "team/p.md" {
			p = f
		}
	}
	if p.Added != 1 || p.Deleted != 1 {
		t.Fatalf("p.md +%d -%d", p.Added, p.Deleted)
	}
	for _, l := range p.Lines {
		if l.Kind == DiffAdd && (l.Text != "2" || l.NewLine != 2) {
			t.Fatalf("added line = %+v", l)
		}
	}
}

func TestPreReceiveHookOnlyAcceptsKnowledgeBranches(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	head, _ := s.Head(ctx, testWorkspace)
	mustCommit(t, s, MainRef, head, head, FileChange{Path: "team/p.md", Content: []byte("x\n")})

	work := filepath.Join(t.TempDir(), "clone")
	gitRun(t, "", "clone", "-q", s.RepoDir(testWorkspace), work)
	if err := os.WriteFile(filepath.Join(work, "team", "p.md"), []byte("y\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "edit")

	if out, err := gitOut(work, "push", "-q", "origin", "HEAD:refs/heads/main"); err == nil {
		t.Fatalf("push to main accepted: %s", out)
	}
	if out, err := gitOut(work, "push", "-q", "origin", "HEAD:refs/heads/kb/agent-1"); err != nil {
		t.Fatalf("push to kb/ rejected: %v %s", err, out)
	}
}

func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	if out, err := gitOut(dir, args...); err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
}

func gitOut(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	var b bytes.Buffer
	cmd.Stdout, cmd.Stderr = &b, &b
	err := cmd.Run()

	return b.String(), err
}

func TestBuiltinFilesCoverSchemaLayout(t *testing.T) {
	files, err := BuiltinFiles(SchemaInput{Name: "团队知识库", Slug: "team", Purpose: "Acme 团队"})
	if err != nil {
		t.Fatal(err)
	}
	paths := map[string]bool{}
	for _, f := range files {
		paths[f.Path] = true
	}
	for _, want := range []string{"team/AGENTS.md", "team/purpose.md", "team/index.md", "team/log.md", "team/overview.md", "team/.claims/.gitkeep", "team/wiki/entities/.gitkeep", "team/wiki/queries/.gitkeep"} {
		if !paths[want] {
			t.Fatalf("missing %s", want)
		}
	}
}
