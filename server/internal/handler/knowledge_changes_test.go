package handler

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yunboom/marvis/server/internal/knowledge"
	"github.com/yunboom/marvis/server/internal/testutil"
)

// pushBranch 模拟智能体推送：在主线基础上提交 changes 到 kb/ 分支。
func pushBranch(t *testing.T, wsID, branch string, files map[string]string) string {
	t.Helper()
	ctx := context.Background()
	head, err := testHandler.Knowledge.Head(ctx, wsID)
	if err != nil {
		t.Fatalf("Head: %v", err)
	}
	old, _ := testHandler.Knowledge.Resolve(ctx, wsID, knowledge.BranchRef(branch))
	parent := head
	if old != "" {
		parent = old
	}
	changes := make([]knowledge.FileChange, 0, len(files))
	for p, c := range files {
		changes = append(changes, knowledge.FileChange{Path: p, Content: []byte(c)})
	}
	commit, err := testHandler.Knowledge.Commit(ctx, wsID, knowledge.BranchRef(branch), parent, old, "agent edit", knowledge.Signature{Name: "agent"}, changes)
	if err != nil {
		t.Fatalf("push branch: %v", err)
	}

	return commit
}

func createChange(t *testing.T, userID, wsID string, body map[string]any, want int) KnowledgeChangeDetailResponse {
	t.Helper()
	var out KnowledgeChangeDetailResponse
	resp := testutil.Call(t, testHandler.CreateKnowledgeChangeRequest, kbRequest(userID, wsID, http.MethodPost, "/api/knowledge/changes", body)).Want(want)
	if want == http.StatusCreated {
		resp.JSON(&out)
	}

	return out
}

func TestCreateKnowledgeChangeRequestTracksSlugsConflictsAndAnnotations(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	seedKnowledgePages(t, wsID, ownerID, map[string]string{"team/wiki/concepts/refund.md": "---\ntitle: 退款\n---\n旧内容。\n"})
	kb := listKnowledgeBases(t, ownerID, wsID)[0]
	annID := dbfx.Insert(t, "knowledge_annotation", testutil.Cols{
		"workspace_id": wsID, "knowledge_base_id": kb.ID, "page_path": "team/wiki/concepts/refund.md",
		"quote": "旧内容。", "body": "写错了", "author_type": "member", "author_id": ownerID,
	})

	pushBranch(t, wsID, "kb/fix-1", map[string]string{"team/wiki/concepts/refund.md": "---\ntitle: 退款\n---\n新内容。\n"})
	cr := createChange(t, ownerID, wsID, map[string]any{
		"branch": "kb/fix-1", "title": "修正退款", "source": "fix", "summary": "按批注修改", "risk": "low", "annotation_ids": []string{annID},
	}, http.StatusCreated)
	if cr.Number != 1 || cr.Status != changeStatusOpen || cr.Conflict || strings.Join(cr.KBSlugs, ",") != "team" {
		t.Fatalf("created = %+v", cr.KnowledgeChangeRequestResponse)
	}
	if len(cr.Groups) != 1 || cr.Groups[0].Slug != "team" || cr.Groups[0].Files[0].Added != 1 {
		t.Fatalf("groups = %+v", cr.Groups)
	}
	if got := queryString(t, `SELECT status FROM knowledge_annotation WHERE id = $1`, annID); got != annotationProcessing {
		t.Fatalf("annotation status = %q", got)
	}

	createChange(t, ownerID, wsID, map[string]any{"branch": "kb/fix-1", "title": "again"}, http.StatusConflict)
	createChange(t, ownerID, wsID, map[string]any{"branch": "main", "title": "x"}, http.StatusBadRequest)
	createChange(t, ownerID, wsID, map[string]any{"branch": "kb/missing", "title": "x"}, http.StatusBadRequest)
	pushBranch(t, wsID, "kb/empty", map[string]string{"team/wiki/concepts/refund.md": "---\ntitle: 退款\n---\n旧内容。\n"})
	createChange(t, ownerID, wsID, map[string]any{"branch": "kb/empty", "title": "x"}, http.StatusBadRequest)

	// 主线被别人改了同一行：更新时检测到冲突。
	seedKnowledgePages(t, wsID, ownerID, map[string]string{"team/wiki/concepts/refund.md": "---\ntitle: 退款\n---\n别人的内容。\n"})
	var updated KnowledgeChangeDetailResponse
	testutil.Call(t, testHandler.UpdateKnowledgeChangeRequest, kbRequest(ownerID, wsID, http.MethodPatch, "/api/knowledge/changes/1",
		map[string]any{"summary": "改了摘要"}, "number", "1")).Want(http.StatusOK).JSON(&updated)
	if !updated.Conflict || strings.Join(updated.ConflictFiles, ",") != "team/wiki/concepts/refund.md" || updated.Summary != "改了摘要" {
		t.Fatalf("updated = %+v", updated.KnowledgeChangeRequestResponse)
	}

	var list []KnowledgeChangeRequestResponse
	testutil.Call(t, testHandler.ListKnowledgeChangeRequests, kbRequest(ownerID, wsID, http.MethodGet, "/api/knowledge/changes?status=open", nil)).Want(http.StatusOK).JSON(&list)
	if len(list) != 1 || list[0].AuthorName == "" {
		t.Fatalf("list = %+v", list)
	}
	var got KnowledgeChangeDetailResponse
	testutil.Call(t, testHandler.GetKnowledgeChangeRequest, kbRequest(ownerID, wsID, http.MethodGet, "/api/knowledge/changes/1", nil, "number", "1")).Want(http.StatusOK).JSON(&got)
	if got.Number != 1 || len(got.Groups) != 1 {
		t.Fatalf("get = %+v", got)
	}
	testutil.Call(t, testHandler.GetKnowledgeChangeRequest, kbRequest(ownerID, wsID, http.MethodGet, "/api/knowledge/changes/99", nil, "number", "99")).Want(http.StatusNotFound)
}

// TestKnowledgeGitSmartHTTP 用真实 git 客户端走 clone → commit → push。
func TestKnowledgeGitSmartHTTP(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	seedKnowledgePages(t, wsID, ownerID, map[string]string{"team/wiki/concepts/a.md": "---\ntitle: A\n---\na\n"})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Header.Set("X-User-ID", ownerID)
		r.Header.Set("X-Workspace-ID", wsID)
		testHandler.KnowledgeGit(w, r)
	}))
	defer srv.Close()

	dir := filepath.Join(t.TempDir(), "kb")
	git := func(args ...string) (string, error) {
		cmd := exec.Command("git", args...)
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		var out bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &out
		if !strings.HasPrefix(args[0], "clone") {
			cmd.Dir = dir
		}
		err := cmd.Run()
		return out.String(), err
	}
	if out, err := git("clone", "-q", srv.URL+knowledgeGitPrefix+"/"+knowledgeGitRepoName, dir); err != nil {
		t.Fatalf("clone: %v %s", err, out)
	}
	if _, err := os.Stat(filepath.Join(dir, "team", "wiki", "concepts", "a.md")); err != nil {
		t.Fatalf("cloned tree missing page: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "team", "wiki", "concepts", "a.md"), []byte("---\ntitle: A\n---\nb\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := git("-c", "user.name=agent", "-c", "user.email=a@a", "commit", "-qam", "edit"); err != nil {
		t.Fatalf("commit: %v %s", err, out)
	}
	if out, err := git("push", "-q", "origin", "HEAD:refs/heads/main"); err == nil {
		t.Fatalf("push to main accepted: %s", out)
	}
	if out, err := git("push", "-q", "origin", "HEAD:refs/heads/kb/agent-1"); err != nil {
		t.Fatalf("push kb branch: %v %s", err, out)
	}

	cr := createChange(t, ownerID, wsID, map[string]any{"branch": "kb/agent-1", "title": "edit a"}, http.StatusCreated)
	if cr.Source != changeSourceEdit || len(cr.Groups) != 1 {
		t.Fatalf("change from pushed branch = %+v", cr.KnowledgeChangeRequestResponse)
	}
}

func TestGetKnowledgeChangeRequestReportsChecksForTouchedFiles(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	// 主线上已有一个缺字段的页面：它不在本次变更里，不应出现在检查结果中。
	seedKnowledgePages(t, wsID, ownerID, map[string]string{"team/wiki/concepts/old.md": "# Old\n"})

	pushBranch(t, wsID, "kb/checks", map[string]string{
		"team/wiki/concepts/refund.md": "---\ntype: concept\ntitle: Refund\ndescription: D.\ndomains: [dev]\nstale_after: 2020-01-01\n---\n\nSee [gone](gone.md).\n",
	})
	createChange(t, ownerID, wsID, map[string]any{"branch": "kb/checks", "title": "checks"}, http.StatusCreated)

	var got KnowledgeChangeDetailResponse
	testutil.Call(t, testHandler.GetKnowledgeChangeRequest, kbRequest(ownerID, wsID, http.MethodGet, "/api/knowledge/changes/1", nil, "number", "1")).Want(http.StatusOK).JSON(&got)

	codes := map[string]bool{}
	for _, is := range got.Checks.Lint {
		if is.Path != "team/wiki/concepts/refund.md" {
			t.Fatalf("lint issue outside the change: %+v", is)
		}
		codes[is.Code] = true
	}
	if !codes[knowledge.LintBrokenLink] || !codes[knowledge.LintNotInIndex] {
		t.Fatalf("lint = %+v", got.Checks.Lint)
	}
	if len(got.Checks.Stale) != 1 || got.Checks.Stale[0].Reason != knowledge.StaleExpired {
		t.Fatalf("stale = %+v", got.Checks.Stale)
	}
}

func TestGetKnowledgeChangeRequestRechecksConflictsAgainstCurrentMain(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	seedKnowledgePages(t, wsID, ownerID, map[string]string{"team/wiki/concepts/refund.md": "# Refund\n\nold\n"})
	pushBranch(t, wsID, "kb/edit", map[string]string{"team/wiki/concepts/refund.md": "# Refund\n\nmine\n"})
	if cr := createChange(t, ownerID, wsID, map[string]any{"branch": "kb/edit", "title": "edit"}, http.StatusCreated); cr.Conflict {
		t.Fatalf("fresh change request already conflicts")
	}

	// 主线在变更请求创建后改了同一行：查看详情时应当看到冲突，而不是创建时的「可合并」。
	seedKnowledgePages(t, wsID, ownerID, map[string]string{"team/wiki/concepts/refund.md": "# Refund\n\ntheirs\n"})
	var got KnowledgeChangeDetailResponse
	testutil.Call(t, testHandler.GetKnowledgeChangeRequest, kbRequest(ownerID, wsID, http.MethodGet, "/api/knowledge/changes/1", nil, "number", "1")).Want(http.StatusOK).JSON(&got)
	if !got.Conflict || strings.Join(got.ConflictFiles, ",") != "team/wiki/concepts/refund.md" {
		t.Fatalf("detail = conflict %v files %v", got.Conflict, got.ConflictFiles)
	}
}
