package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/yunboom/marvis/server/internal/knowledge"
	"github.com/yunboom/marvis/server/internal/testutil"
)

const refundPath = "team/wiki/concepts/refund.md"

func mergeChange(t *testing.T, userID, wsID, number string, want int) {
	t.Helper()
	testutil.Call(t, testHandler.MergeKnowledgeChangeRequest, kbRequest(userID, wsID, http.MethodPost, "/api/knowledge/changes/"+number+"/merge", nil, "number", number)).Want(want)
}

func TestMergeKnowledgeChangeRequestRequiresAdminAndResolvesAnnotations(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	memberID := knowledgeMember(t, wsID, "member")
	seedKnowledgePages(t, wsID, ownerID, map[string]string{refundPath: "---\ntitle: 退款\n---\n旧。\n"})
	kb := listKnowledgeBases(t, ownerID, wsID)[0]
	annID := dbfx.Insert(t, "knowledge_annotation", testutil.Cols{
		"workspace_id": wsID, "knowledge_base_id": kb.ID, "page_path": refundPath, "quote": "旧。", "body": "改", "author_type": "member", "author_id": memberID,
	})
	pushBranch(t, wsID, "kb/fix-merge", map[string]string{refundPath: "---\ntitle: 退款\n---\n新。\n"})
	createChange(t, memberID, wsID, map[string]any{"branch": "kb/fix-merge", "title": "fix", "annotation_ids": []string{annID}}, http.StatusCreated)

	mergeChange(t, memberID, wsID, "1", http.StatusForbidden)
	machine := kbRequest(ownerID, wsID, http.MethodPost, "/api/knowledge/changes/1/merge", nil, "number", "1")
	machine.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, testHandler.MergeKnowledgeChangeRequest, machine).Want(http.StatusForbidden)

	mergeChange(t, ownerID, wsID, "1", http.StatusOK)
	if got, _ := repoFile(t, wsID, refundPath); got != "---\ntitle: 退款\n---\n新。\n" {
		t.Fatalf("main after merge = %q", got)
	}
	if got := queryString(t, `SELECT status FROM knowledge_annotation WHERE id = $1`, annID); got != annotationResolved {
		t.Fatalf("annotation = %q, want resolved", got)
	}
	if _, err := testHandler.Knowledge.Resolve(context.Background(), wsID, knowledge.BranchRef("kb/fix-merge")); err != knowledge.ErrNotFound {
		t.Fatalf("branch not deleted after merge: %v", err)
	}
	mergeChange(t, ownerID, wsID, "1", http.StatusConflict)

	var history []KnowledgeChangeRequestResponse
	testutil.Call(t, testHandler.ListKnowledgeHistory, kbRequest(memberID, wsID, http.MethodGet, "/api/knowledge/history", nil)).Want(http.StatusOK).JSON(&history)
	if len(history) != 1 || history[0].MergeCommit == nil {
		t.Fatalf("history = %+v", history)
	}

	var revert KnowledgeChangeDetailResponse
	testutil.Call(t, testHandler.RevertKnowledgeChangeRequest, kbRequest(memberID, wsID, http.MethodPost, "/api/knowledge/changes/1/revert", nil, "number", "1")).
		Want(http.StatusCreated).JSON(&revert)
	if revert.Source != changeSourceRevert || revert.Number != 2 {
		t.Fatalf("revert = %+v", revert.KnowledgeChangeRequestResponse)
	}
	mergeChange(t, ownerID, wsID, "2", http.StatusOK)
	if got, _ := repoFile(t, wsID, refundPath); got != "---\ntitle: 退款\n---\n旧。\n" {
		t.Fatalf("main after revert = %q", got)
	}
}

func TestMergeKnowledgeChangeRequestReportsConflicts(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	seedKnowledgePages(t, wsID, ownerID, map[string]string{refundPath: "---\ntitle: 退款\n---\n旧。\n"})
	pushBranch(t, wsID, "kb/a", map[string]string{refundPath: "---\ntitle: 退款\n---\nA。\n"})
	createChange(t, ownerID, wsID, map[string]any{"branch": "kb/a", "title": "a"}, http.StatusCreated)
	seedKnowledgePages(t, wsID, ownerID, map[string]string{refundPath: "---\ntitle: 退款\n---\nB。\n"})

	mergeChange(t, ownerID, wsID, "1", http.StatusConflict)
	if got := queryString(t, `SELECT conflict::text FROM knowledge_change_request WHERE workspace_id = $1 AND number = 1`, wsID); got != "true" {
		t.Fatalf("conflict flag = %q", got)
	}
	if got, _ := repoFile(t, wsID, refundPath); got != "---\ntitle: 退款\n---\nB。\n" {
		t.Fatalf("main changed by a conflicting merge: %q", got)
	}
}

func TestCloseKnowledgeChangeRequestReleasesAnnotations(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	authorID := knowledgeMember(t, wsID, "member")
	otherID := knowledgeMember(t, wsID, "member")
	seedKnowledgePages(t, wsID, ownerID, map[string]string{refundPath: "---\ntitle: 退款\n---\n旧。\n"})
	kb := listKnowledgeBases(t, ownerID, wsID)[0]
	annID := dbfx.Insert(t, "knowledge_annotation", testutil.Cols{
		"workspace_id": wsID, "knowledge_base_id": kb.ID, "page_path": refundPath, "body": "改", "author_type": "member", "author_id": authorID,
	})
	pushBranch(t, wsID, "kb/close-me", map[string]string{refundPath: "---\ntitle: 退款\n---\n新。\n"})
	createChange(t, authorID, wsID, map[string]any{"branch": "kb/close-me", "title": "x", "annotation_ids": []string{annID}}, http.StatusCreated)

	var comment KnowledgeChangeComment
	testutil.Call(t, testHandler.CreateKnowledgeChangeComment, kbRequest(otherID, wsID, http.MethodPost, "/api/knowledge/changes/1/comments",
		map[string]any{"path": refundPath, "line": 4, "body": "请注明出处"}, "number", "1")).Want(http.StatusCreated).JSON(&comment)
	var detail KnowledgeChangeDetailResponse
	testutil.Call(t, testHandler.GetKnowledgeChangeRequest, kbRequest(authorID, wsID, http.MethodGet, "/api/knowledge/changes/1", nil, "number", "1")).Want(http.StatusOK).JSON(&detail)
	if len(detail.Comments) != 1 || detail.Comments[0].Body != "请注明出处" {
		t.Fatalf("comments = %+v", detail.Comments)
	}

	testutil.Call(t, testHandler.CloseKnowledgeChangeRequest, kbRequest(otherID, wsID, http.MethodPost, "/api/knowledge/changes/1/close", nil, "number", "1")).Want(http.StatusForbidden)
	testutil.Call(t, testHandler.CloseKnowledgeChangeRequest, kbRequest(authorID, wsID, http.MethodPost, "/api/knowledge/changes/1/close", nil, "number", "1")).Want(http.StatusOK)
	if got := queryString(t, `SELECT status FROM knowledge_annotation WHERE id = $1`, annID); got != annotationPending {
		t.Fatalf("annotation = %q, want pending", got)
	}
	if got := queryString(t, `SELECT coalesce(change_request_id::text, '') FROM knowledge_annotation WHERE id = $1`, annID); got != "" {
		t.Fatalf("annotation still linked: %q", got)
	}
}

func TestSubmitKnowledgeEditOpensChangeRequestAdminCanMergeOwn(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	seedKnowledgePages(t, wsID, ownerID, map[string]string{refundPath: "---\ntitle: 退款\n---\n旧。\n"})
	var page KnowledgePageResponse
	testutil.Call(t, testHandler.GetKnowledgePage, kbRequest(ownerID, wsID, http.MethodGet, "/api/knowledge/bases/team/page?path="+refundPath, nil, "id", "team")).Want(http.StatusOK).JSON(&page)

	testutil.Call(t, testHandler.SubmitKnowledgeEdit, kbRequest(ownerID, wsID, http.MethodPost, "/api/knowledge/edits",
		map[string]any{"path": refundPath, "content": page.Markdown, "base_commit": page.Commit})).Want(http.StatusBadRequest)
	testutil.Call(t, testHandler.SubmitKnowledgeEdit, kbRequest(ownerID, wsID, http.MethodPost, "/api/knowledge/edits",
		map[string]any{"path": "nope/wiki/a.md", "content": "x"})).Want(http.StatusBadRequest)

	var cr KnowledgeChangeDetailResponse
	testutil.Call(t, testHandler.SubmitKnowledgeEdit, kbRequest(ownerID, wsID, http.MethodPost, "/api/knowledge/edits",
		map[string]any{"path": refundPath, "content": "---\ntitle: 退款\n---\n手改。\n", "base_commit": page.Commit})).Want(http.StatusCreated).JSON(&cr)
	if cr.Source != changeSourceEdit || cr.AuthorID != ownerID {
		t.Fatalf("edit change = %+v", cr.KnowledgeChangeRequestResponse)
	}
	if got, _ := repoFile(t, wsID, refundPath); got != "---\ntitle: 退款\n---\n旧。\n" {
		t.Fatalf("edit reached main before review: %q", got)
	}
	mergeChange(t, ownerID, wsID, "1", http.StatusOK)
	if got, _ := repoFile(t, wsID, refundPath); got != "---\ntitle: 退款\n---\n手改。\n" {
		t.Fatalf("main after merging own edit = %q", got)
	}
}
