package handler

import (
	"net/http"
	"testing"

	"github.com/yunboom/marvis/server/internal/testutil"
)

func TestKnowledgeAnnotationsLifecycleAndReanchoring(t *testing.T) {
	wsID, ownerID := knowledgeWorkspace(t)
	memberID := knowledgeMember(t, wsID, "member")
	seedKnowledgePages(t, wsID, ownerID, map[string]string{
		refundPath: "---\ntitle: 退款\n---\n已发货订单先退货入库。原路退款次日批量提交。\n",
	})
	path := "/api/knowledge/bases/team/annotations"

	var sentence, page KnowledgeAnnotationResponse
	testutil.Call(t, testHandler.CreateKnowledgeAnnotation, kbRequest(memberID, wsID, http.MethodPost, path,
		map[string]any{"page_path": refundPath, "quote": "原路退款次日批量提交。", "body": "补充原因"}, "id", "team")).
		Want(http.StatusCreated).JSON(&sentence)
	if sentence.AnchorLost || sentence.PageTitle != "退款" || sentence.Status != annotationPending || sentence.AuthorName == "" {
		t.Fatalf("sentence annotation = %+v", sentence)
	}
	testutil.Call(t, testHandler.CreateKnowledgeAnnotation, kbRequest(memberID, wsID, http.MethodPost, path,
		map[string]any{"page_path": refundPath, "body": "整页缺少来源"}, "id", "team")).Want(http.StatusCreated).JSON(&page)
	if page.Quote != "" || page.AnchorLost {
		t.Fatalf("page annotation = %+v", page)
	}

	testutil.Call(t, testHandler.CreateKnowledgeAnnotation, kbRequest(memberID, wsID, http.MethodPost, path,
		map[string]any{"page_path": "other/wiki/x.md", "body": "x"}, "id", "team")).Want(http.StatusBadRequest)
	testutil.Call(t, testHandler.CreateKnowledgeAnnotation, kbRequest(memberID, wsID, http.MethodPost, path,
		map[string]any{"page_path": "team/wiki/missing.md", "body": "x"}, "id", "team")).Want(http.StatusBadRequest)
	testutil.Call(t, testHandler.CreateKnowledgeAnnotation, kbRequest(memberID, wsID, http.MethodPost, path,
		map[string]any{"page_path": refundPath, "body": " "}, "id", "team")).Want(http.StatusBadRequest)

	// 页面被改写，原句不再存在：句子批注退化为页面批注。
	seedKnowledgePages(t, wsID, ownerID, map[string]string{
		refundPath: "---\ntitle: 退款\n---\n已发货订单先退货入库。退款在次日 02:00 批量提交。\n",
	})
	var list []KnowledgeAnnotationResponse
	testutil.Call(t, testHandler.ListKnowledgeAnnotations, kbRequest(ownerID, wsID, http.MethodGet, path+"?status=pending", nil, "id", "team")).
		Want(http.StatusOK).JSON(&list)
	if len(list) != 2 {
		t.Fatalf("pending list = %+v", list)
	}
	for _, a := range list {
		if a.ID == sentence.ID && !a.AnchorLost {
			t.Fatalf("rewritten sentence still anchored: %+v", a)
		}
	}

	update := func(id, status string, want int) {
		t.Helper()
		testutil.Call(t, testHandler.UpdateKnowledgeAnnotation, kbRequest(memberID, wsID, http.MethodPatch, "/api/knowledge/annotations/"+id,
			map[string]any{"status": status}, "annotationId", id)).Want(want)
	}
	update(page.ID, annotationDismissed, http.StatusOK)
	update(page.ID, annotationPending, http.StatusOK)
	update(page.ID, annotationResolved, http.StatusBadRequest)

	dbfx.Exec(t, `UPDATE knowledge_annotation SET status = 'processing' WHERE id = $1`, sentence.ID)
	update(sentence.ID, annotationDismissed, http.StatusConflict)
}
