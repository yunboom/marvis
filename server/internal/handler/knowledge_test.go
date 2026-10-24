package handler

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/yunboom/marvis/server/internal/testutil"
)

// knowledgeWorkspace 建一个独立的工作区和 owner，知识库仓库状态不与其他测试共享。
func knowledgeWorkspace(t *testing.T) (wsID, ownerID string) {
	t.Helper()
	if testHandler == nil {
		t.Skip("database not available")
	}
	suffix := uuid.NewString()[:8]
	ownerID = dbfx.User(t, "KB Owner "+suffix, "kb-owner-"+suffix+"@marvis.ai")
	wsID = dbfx.Workspace(t, "KB "+suffix, "kb-"+suffix)
	dbfx.Member(t, wsID, ownerID, "owner")
	for _, table := range []string{"knowledge_base", "knowledge_repo", "knowledge_change_request", "knowledge_annotation", "knowledge_gap", "knowledge_session"} {
		dbfx.Cleanup(t, `DELETE FROM `+table+` WHERE workspace_id = $1`, wsID)
	}
	t.Cleanup(func() { testHandler.removeKnowledgeRepo(wsID) })

	return wsID, ownerID
}

func queryString(t *testing.T, sql string, args ...any) string {
	t.Helper()
	var s string
	dbfx.QueryRow(t, sql, args...).Scan(&s)

	return s
}

func knowledgeMember(t *testing.T, wsID, role string) string {
	t.Helper()
	suffix := uuid.NewString()[:8]
	userID := dbfx.User(t, "KB "+role+" "+suffix, "kb-"+role+"-"+suffix+"@marvis.ai")
	dbfx.Member(t, wsID, userID, role)

	return userID
}

func kbRequest(userID, wsID, method, path string, body any, params ...string) *http.Request {
	req := newRequestAs(userID, method, path, body)
	req.Header.Set("X-Workspace-ID", wsID)
	if len(params) > 0 {
		return testutil.WithURLParams(req, params...)
	}

	return req
}

func listKnowledgeBases(t *testing.T, userID, wsID string) []KnowledgeBaseResponse {
	t.Helper()
	var out []KnowledgeBaseResponse
	testutil.Call(t, testHandler.ListKnowledgeBases, kbRequest(userID, wsID, http.MethodGet, "/api/knowledge/bases", nil)).Want(http.StatusOK).JSON(&out)

	return out
}

func repoFile(t *testing.T, wsID, path string) (string, bool) {
	t.Helper()
	ctx := context.Background()
	head, err := testHandler.Knowledge.Head(ctx, wsID)
	if err != nil {
		t.Fatalf("Head: %v", err)
	}
	b, err := testHandler.Knowledge.ReadFile(ctx, wsID, head, path)
	if err != nil {
		return "", false
	}

	return string(b), true
}

func TestListKnowledgeBasesSeedsBuiltinOnce(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)

	first := listKnowledgeBases(t, ownerID, wsID)
	if len(first) != 1 || first[0].Slug != builtinKnowledgeSlug || first[0].Name != builtinKnowledgeName {
		t.Fatalf("first list = %+v, want the built-in team knowledge base", first)
	}
	if again := listKnowledgeBases(t, ownerID, wsID); len(again) != 1 {
		t.Fatalf("second list = %d bases, want 1", len(again))
	}

	agents, ok := repoFile(t, wsID, "team/AGENTS.md")
	if !ok || !strings.Contains(agents, "maintenance rules") {
		t.Fatalf("team/AGENTS.md missing or wrong: %q", agents)
	}
	purpose, _ := repoFile(t, wsID, "team/purpose.md")
	if !strings.Contains(purpose, "团队知识库") {
		t.Fatalf("purpose.md = %q, want the workspace name", purpose)
	}
	readme, _ := repoFile(t, wsID, "README.md")
	if !strings.Contains(readme, "`team/`") {
		t.Fatalf("README = %q, want the team directory listed", readme)
	}
}

func TestCreateKnowledgeBaseDerivesSlugAndRejectsDuplicates(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	memberID := knowledgeMember(t, wsID, "member")

	var payments KnowledgeBaseResponse
	testutil.Call(t, testHandler.CreateKnowledgeBase, kbRequest(memberID, wsID, http.MethodPost, "/api/knowledge/bases",
		map[string]any{"name": "Payments Core", "description": "支付中台"})).Want(http.StatusCreated).JSON(&payments)
	if payments.Slug != "payments-core" || payments.CreatedBy != memberID {
		t.Fatalf("created = %+v", payments)
	}

	var chinese KnowledgeBaseResponse
	testutil.Call(t, testHandler.CreateKnowledgeBase, kbRequest(ownerID, wsID, http.MethodPost, "/api/knowledge/bases",
		map[string]any{"name": "测试实验室"})).Want(http.StatusCreated).JSON(&chinese)
	if !strings.HasPrefix(chinese.Slug, "kb-") {
		t.Fatalf("non-ASCII name slug = %q, want kb-N", chinese.Slug)
	}

	testutil.Call(t, testHandler.CreateKnowledgeBase, kbRequest(ownerID, wsID, http.MethodPost, "/api/knowledge/bases",
		map[string]any{"name": "Dup", "slug": "payments-core"})).Want(http.StatusConflict)
	testutil.Call(t, testHandler.CreateKnowledgeBase, kbRequest(ownerID, wsID, http.MethodPost, "/api/knowledge/bases",
		map[string]any{"name": "Bad", "slug": "Bad Slug"})).Want(http.StatusBadRequest)
	testutil.Call(t, testHandler.CreateKnowledgeBase, kbRequest(ownerID, wsID, http.MethodPost, "/api/knowledge/bases",
		map[string]any{"name": " "})).Want(http.StatusBadRequest)

	if got := listKnowledgeBases(t, ownerID, wsID); len(got) != 3 {
		t.Fatalf("bases = %d, want team + 2 created", len(got))
	}
	if _, ok := repoFile(t, wsID, "payments-core/wiki/entities/.gitkeep"); !ok {
		t.Fatalf("payments-core directory not created")
	}
	readme, _ := repoFile(t, wsID, "README.md")
	if !strings.Contains(readme, "payments-core") || !strings.Contains(readme, "支付中台") {
		t.Fatalf("README not updated: %q", readme)
	}
}

func TestCreateKnowledgeBaseRejectsAgentFromOtherWorkspace(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	foreign := uuid.NewString()

	testutil.Call(t, testHandler.CreateKnowledgeBase, kbRequest(ownerID, wsID, http.MethodPost, "/api/knowledge/bases",
		map[string]any{"name": "X", "maintainer_agent_id": foreign})).Want(http.StatusBadRequest)
}

func TestUpdateKnowledgeBaseRequiresCreatorOrAdmin(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	creatorID := knowledgeMember(t, wsID, "member")
	otherID := knowledgeMember(t, wsID, "member")
	adminID := knowledgeMember(t, wsID, "admin")

	var kb KnowledgeBaseResponse
	testutil.Call(t, testHandler.CreateKnowledgeBase, kbRequest(creatorID, wsID, http.MethodPost, "/api/knowledge/bases",
		map[string]any{"name": "Ops"})).Want(http.StatusCreated).JSON(&kb)

	path := "/api/knowledge/bases/" + kb.ID
	testutil.Call(t, testHandler.UpdateKnowledgeBase, kbRequest(otherID, wsID, http.MethodPatch, path,
		map[string]any{"name": "Hijack"}, "id", kb.ID)).Want(http.StatusForbidden)

	var updated KnowledgeBaseResponse
	testutil.Call(t, testHandler.UpdateKnowledgeBase, kbRequest(creatorID, wsID, http.MethodPatch, path,
		map[string]any{"description": "运维手册"}, "id", kb.ID)).Want(http.StatusOK).JSON(&updated)
	if updated.Description != "运维手册" || updated.Name != "Ops" {
		t.Fatalf("creator update = %+v", updated)
	}
	testutil.Call(t, testHandler.UpdateKnowledgeBase, kbRequest(adminID, wsID, http.MethodPatch, path,
		map[string]any{"name": "Operations"}, "id", kb.ID)).Want(http.StatusOK).JSON(&updated)
	testutil.Call(t, testHandler.UpdateKnowledgeBase, kbRequest(ownerID, wsID, http.MethodPatch, "/api/knowledge/bases/ops",
		map[string]any{"name": "By slug"}, "id", "ops")).Want(http.StatusOK)

	readme, _ := repoFile(t, wsID, "README.md")
	if !strings.Contains(readme, "By slug") {
		t.Fatalf("README not refreshed after rename: %q", readme)
	}
}

func TestDeleteKnowledgeBaseRemovesDirectoryAndClosesWork(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	memberID := knowledgeMember(t, wsID, "member")

	var kb KnowledgeBaseResponse
	testutil.Call(t, testHandler.CreateKnowledgeBase, kbRequest(ownerID, wsID, http.MethodPost, "/api/knowledge/bases",
		map[string]any{"name": "Scratch"})).Want(http.StatusCreated).JSON(&kb)

	annID := dbfx.Insert(t, "knowledge_annotation", testutil.Cols{
		"workspace_id": wsID, "knowledge_base_id": kb.ID, "page_path": "scratch/wiki/concepts/a.md",
		"body": "fix me", "author_type": "member", "author_id": ownerID,
	})
	crID := dbfx.Insert(t, "knowledge_change_request", testutil.Cols{
		"workspace_id": wsID, "number": 900, "title": "t", "source": "edit", "author_type": "member", "author_id": ownerID,
		"branch": "kb/test-delete", "base_commit": "x", "head_commit": "y", "kb_slugs": []string{"scratch"},
	})

	path := "/api/knowledge/bases/" + kb.ID
	var impact KnowledgeDeleteImpactResponse
	testutil.Call(t, testHandler.GetKnowledgeDeleteImpact, kbRequest(ownerID, wsID, http.MethodGet, path+"/delete-impact", nil, "id", kb.ID)).
		Want(http.StatusOK).JSON(&impact)
	if impact.OpenAnnotations != 1 || impact.OpenChangeRequests != 1 || impact.LastKnowledgeBase {
		t.Fatalf("impact = %+v", impact)
	}

	testutil.Call(t, testHandler.DeleteKnowledgeBase, kbRequest(memberID, wsID, http.MethodDelete, path, nil, "id", kb.ID)).Want(http.StatusForbidden)
	taskTokenReq := kbRequest(ownerID, wsID, http.MethodDelete, path, nil, "id", kb.ID)
	taskTokenReq.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, testHandler.DeleteKnowledgeBase, taskTokenReq).Want(http.StatusForbidden)

	testutil.Call(t, testHandler.DeleteKnowledgeBase, kbRequest(ownerID, wsID, http.MethodDelete, path, nil, "id", kb.ID)).Want(http.StatusNoContent)

	if _, ok := repoFile(t, wsID, "scratch/AGENTS.md"); ok {
		t.Fatalf("directory still present after delete")
	}
	if got := queryString(t, `SELECT status FROM knowledge_annotation WHERE id = $1`, annID); got != "dismissed" {
		t.Fatalf("annotation status = %q, want dismissed", got)
	}
	if got := queryString(t, `SELECT status FROM knowledge_change_request WHERE id = $1`, crID); got != "closed" {
		t.Fatalf("change request status = %q, want closed", got)
	}
	if got := listKnowledgeBases(t, ownerID, wsID); len(got) != 1 || got[0].Slug != builtinKnowledgeSlug {
		t.Fatalf("after delete = %+v", got)
	}
}
