package handler

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/testutil"
)

// kbAnnotationFixture is a knowledge base with one page to annotate.
type kbAnnotationFixture struct {
	base string
	slug string
	page string
}

const kbAnnotationTestBody = "## 去重\n\n渠道回调按订单号加幂等键去重。幂等键在 Redis 中保存 24 小时。\n\n重复回调直接返回成功。"

func newKbAnnotationFixture(t *testing.T) kbAnnotationFixture {
	t.Helper()

	slug := fmt.Sprintf("ann-%d", time.Now().UnixNano())
	base := insertTestKbBase(t, "Annotation KB", slug)
	page := createTestKbPage(t, base, kb.NewPage{Slug: "callback", Title: "支付回调", Markdown: kbAnnotationTestBody})

	return kbAnnotationFixture{base: base, slug: slug, page: page}
}

// blockID returns the id of the n-th (0-based) block of the fixture page.
func (f kbAnnotationFixture) blockID(t *testing.T, n int) string {
	t.Helper()

	var id string
	dbfx.QueryRow(t, `SELECT blocks->$2::int->>'id' FROM kb_page WHERE id = $1`, f.page, n).Scan(&id)

	return id
}

func createKbAnnotation(t *testing.T, userID, baseRef string, body map[string]any, want int) KbAnnotationResponse {
	t.Helper()

	req := withURLParam(newRequestAs(userID, http.MethodPost, "/api/kb/bases/"+baseRef+"/annotations", body), "kb", baseRef)
	var got KbAnnotationResponse
	rec := testutil.Call(t, testHandler.CreateKbAnnotation, req).Want(want)
	if want == http.StatusCreated {
		rec.JSON(&got)
	}

	return got
}

func listKbAnnotations(t *testing.T, baseRef, query string, want int) []KbAnnotationResponse {
	t.Helper()

	req := withURLParam(newRequest(http.MethodGet, "/api/kb/bases/"+baseRef+"/annotations?"+query, nil), "kb", baseRef)
	var got []KbAnnotationResponse
	rec := testutil.Call(t, testHandler.ListKbAnnotations, req).Want(want)
	if want == http.StatusOK {
		rec.JSON(&got)
	}

	return got
}

func patchKbAnnotation(t *testing.T, userID, id, status string, want int) KbAnnotationResponse {
	t.Helper()

	req := withURLParam(newRequestAs(userID, http.MethodPatch, "/api/kb/annotations/"+id, map[string]any{"status": status}), "id", id)
	var got KbAnnotationResponse
	rec := testutil.Call(t, testHandler.UpdateKbAnnotation, req).Want(want)
	if want == http.StatusOK {
		rec.JSON(&got)
	}

	return got
}

func annotationIDs(list []KbAnnotationResponse) map[string]KbAnnotationResponse {
	out := make(map[string]KbAnnotationResponse, len(list))
	for _, a := range list {
		out[a.ID] = a
	}

	return out
}

func TestCreateAndListKbAnnotations(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbAnnotationFixture(t)
	sentenceBlock := f.blockID(t, 1)

	// The CLI names the page by reference and sends no context.
	sentence := createKbAnnotation(t, testUserID, f.slug, map[string]any{
		"page": f.slug + ":/callback", "block_id": sentenceBlock,
		"quote": "渠道回调按订单号加幂等键去重。", "body": "去重键已经改成渠道交易号。",
	}, http.StatusCreated)
	if sentence.PageID == nil || *sentence.PageID != f.page || sentence.PagePath != "/callback" || sentence.PageTitle != "支付回调" ||
		sentence.BlockID != sentenceBlock || sentence.BlockIndex != 2 || sentence.Status != kb.AnnotationStatusPending ||
		sentence.AnchorLost || sentence.AuthorType != kbActorMember || sentence.AuthorName != handlerTestName {
		t.Fatalf("sentence annotation = %+v", sentence)
	}
	if sentence.Prefix != "去重\n" || sentence.Suffix == "" {
		t.Errorf("context = %q / %q, want the server's own context", sentence.Prefix, sentence.Suffix)
	}
	if sentence.Mention != "[批注 · 支付回调](mention://kb_annotation/"+sentence.ID+")" {
		t.Errorf("mention = %q", sentence.Mention)
	}

	page := createKbAnnotation(t, testUserID, f.base, map[string]any{"page_id": f.page, "body": "整页都需要复核。"}, http.StatusCreated)
	if page.BlockID != "" || page.Quote != "" || page.AnchorLost {
		t.Errorf("page annotation = %+v", page)
	}
	whole := createKbAnnotation(t, testUserID, f.slug, map[string]any{"body": "缺少发布回滚的操作步骤。"}, http.StatusCreated)
	if whole.PageID != nil || whole.PagePath != "" || whole.Mention != "[批注](mention://kb_annotation/"+whole.ID+")" {
		t.Errorf("knowledge base annotation = %+v", whole)
	}

	otherBase := insertTestKbBase(t, "Other KB", fmt.Sprintf("ann-other-%d", time.Now().UnixNano()))
	otherPage := createTestKbPage(t, otherBase, kb.NewPage{Slug: "x", Title: "X", Markdown: "x"})
	for name, body := range map[string]map[string]any{
		"empty body":          {"body": "  "},
		"quote without page":  {"quote": "渠道", "block_id": sentenceBlock, "body": "b"},
		"quote without block": {"page_id": f.page, "quote": "渠道", "body": "b"},
		"page of another kb":  {"page_id": otherPage, "body": "b"},
		"unknown path":        {"page": f.slug + ":/missing", "body": "b"},
		"quote not in block":  {"page_id": f.page, "block_id": f.blockID(t, 2), "quote": "渠道回调按订单号", "body": "b"},
		"unknown block":       {"page_id": f.page, "block_id": "bZZZ", "quote": "渠道", "body": "b"},
	} {
		t.Run(name, func(t *testing.T) {
			createKbAnnotation(t, testUserID, f.slug, body, http.StatusBadRequest)
		})
	}

	pending := listKbAnnotations(t, f.slug, "", http.StatusOK)
	if len(pending) != 3 || pending[0].ID != whole.ID {
		t.Fatalf("pending = %d annotations, want 3 newest first", len(pending))
	}
	if got := listKbAnnotations(t, f.slug, "page=-", http.StatusOK); len(got) != 1 || got[0].ID != whole.ID {
		t.Errorf("page=- listed %d annotations, want the knowledge base one", len(got))
	}
	if got := annotationIDs(listKbAnnotations(t, f.slug, "page="+f.slug+":/callback", http.StatusOK)); len(got) != 2 {
		t.Errorf("page filter listed %d annotations, want 2", len(got))
	}
	listKbAnnotations(t, f.slug, "status=open", http.StatusBadRequest)
	listKbAnnotations(t, f.slug, "page="+f.slug+":/missing", http.StatusNotFound)

	get := withURLParam(newRequest(http.MethodGet, "/api/kb/annotations/"+sentence.ID, nil), "id", sentence.ID)
	var read KbAnnotationResponse
	testutil.Call(t, testHandler.GetKbAnnotation, get).Want(http.StatusOK).JSON(&read)
	if read.ID != sentence.ID || read.Quote != sentence.Quote {
		t.Errorf("get = %+v", read)
	}
}

func TestUpdateKbAnnotationStatus(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbAnnotationFixture(t)
	author := dbfx.User(t, "KB Annotation Author", fmt.Sprintf("kb-ann-author-%d@marvis.ai", time.Now().UnixNano()))
	dbfx.Member(t, testWorkspaceID, author, "member")
	other := dbfx.User(t, "KB Annotation Other", fmt.Sprintf("kb-ann-other-%d@marvis.ai", time.Now().UnixNano()))
	dbfx.Member(t, testWorkspaceID, other, "member")

	created := createKbAnnotation(t, author, f.slug, map[string]any{"page_id": f.page, "body": "过时了。"}, http.StatusCreated)

	patchKbAnnotation(t, other, created.ID, kb.AnnotationStatusDismissed, http.StatusForbidden)
	patchKbAnnotation(t, author, created.ID, "resolved", http.StatusBadRequest)

	dismissed := patchKbAnnotation(t, author, created.ID, kb.AnnotationStatusDismissed, http.StatusOK)
	if dismissed.Status != kb.AnnotationStatusDismissed {
		t.Fatalf("status = %s, want dismissed", dismissed.Status)
	}
	if got := listKbAnnotations(t, f.slug, "status=dismissed", http.StatusOK); len(got) != 1 {
		t.Errorf("dismissed list = %d, want 1", len(got))
	}
	if got := listKbAnnotations(t, f.slug, "", http.StatusOK); len(got) != 0 {
		t.Errorf("pending list = %d, want 0 after dismissing", len(got))
	}

	// The knowledge base creator (testUserID, also the owner) can reopen.
	if reopened := patchKbAnnotation(t, testUserID, created.ID, kb.AnnotationStatusPending, http.StatusOK); reopened.Status != kb.AnnotationStatusPending {
		t.Fatalf("status = %s, want pending", reopened.Status)
	}

	// Once a merge request handles it, it can no longer be dismissed.
	mrID := dbfx.Insert(t, "kb_merge_request", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": f.base, "number": 7, "title": "fix",
		"source": "annotations", "author_type": "member", "author_id": testUserID,
		"draft_id": testutil.Raw("gen_random_uuid()"),
	})
	changed, err := kb.AttachAnnotations(context.Background(), testHandler.Queries, parseUUID(f.base), parseUUID(mrID), []pgtype.UUID{parseUUID(created.ID)})
	if err != nil || len(changed) != 1 {
		t.Fatalf("AttachAnnotations = %v, %+v", changed, err)
	}
	patchKbAnnotation(t, author, created.ID, kb.AnnotationStatusDismissed, http.StatusConflict)

	processing := listKbAnnotations(t, f.slug, "status=processing", http.StatusOK)
	if len(processing) != 1 || processing[0].MRNumber == nil || *processing[0].MRNumber != 7 || *processing[0].MergeRequestID != mrID {
		t.Errorf("processing = %+v, want the annotation on MR 7", processing)
	}
}

func TestKbAnnotationMergeRequestLifecycle(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	f := newKbAnnotationFixture(t)
	insert := func(status string) string {
		return dbfx.Insert(t, "kb_annotation", testutil.Cols{
			"workspace_id": testWorkspaceID, "knowledge_base_id": f.base, "page_id": f.page, "body": "b",
			"author_type": "member", "author_id": testUserID, "status": status,
		})
	}
	pending, dismissed := insert(kb.AnnotationStatusPending), insert(kb.AnnotationStatusDismissed)
	statusOf := func(id string) (string, bool) {
		var status string
		var mr pgtype.UUID
		dbfx.QueryRow(t, `SELECT status, merge_request_id FROM kb_annotation WHERE id = $1`, id).Scan(&status, &mr)
		return status, mr.Valid
	}

	mr := parseUUID(dbfx.Insert(t, "kb_merge_request", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": f.base, "number": 8, "title": "fix",
		"source": "annotations", "author_type": "member", "author_id": testUserID,
		"draft_id": testutil.Raw("gen_random_uuid()"),
	}))
	ids := []pgtype.UUID{parseUUID(pending), parseUUID(dismissed)}

	// Submitting: only the pending one is picked up.
	if changed, err := kb.AttachAnnotations(ctx, testHandler.Queries, parseUUID(f.base), mr, ids); err != nil || len(changed) != 1 {
		t.Fatalf("attach = %v, %+v", changed, err)
	}
	if s, linked := statusOf(pending); s != kb.AnnotationStatusProcessing || !linked {
		t.Fatalf("after attach: %s linked=%v", s, linked)
	}

	// Closing puts it back in the queue.
	if changed, err := kb.ReleaseAnnotations(ctx, testHandler.Queries, mr); err != nil || len(changed) != 1 {
		t.Fatalf("release = %v, %+v", changed, err)
	}
	if s, linked := statusOf(pending); s != kb.AnnotationStatusPending || linked {
		t.Fatalf("after release: %s linked=%v", s, linked)
	}

	// Merging resolves it and keeps the merge request.
	if _, err := kb.AttachAnnotations(ctx, testHandler.Queries, parseUUID(f.base), mr, ids); err != nil {
		t.Fatal(err)
	}
	if changed, err := kb.ResolveAnnotations(ctx, testHandler.Queries, mr); err != nil || len(changed) != 1 {
		t.Fatalf("resolve = %v, %+v", changed, err)
	}
	if s, linked := statusOf(pending); s != kb.AnnotationStatusResolved || !linked {
		t.Errorf("after resolve: %s linked=%v", s, linked)
	}
	if s, _ := statusOf(dismissed); s != kb.AnnotationStatusDismissed {
		t.Errorf("dismissed annotation became %s", s)
	}
}

func TestRelocateKbAnnotations(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	f := newKbAnnotationFixture(t)
	b1, b2, b3 := f.blockID(t, 0), f.blockID(t, 1), f.blockID(t, 2)
	annotate := func(blockID, quote string) string {
		return createKbAnnotation(t, testUserID, f.slug, map[string]any{
			"page_id": f.page, "block_id": blockID, "quote": quote, "body": "b",
		}, http.StatusCreated).ID
	}
	kept := annotate(b3, "重复回调直接返回成功。")
	rewritten := annotate(b2, "渠道回调按订单号加幂等键去重。")
	lost := annotate(b1, "去重")
	resolved := annotate(b2, "幂等键在 Redis 中保存 24 小时。")
	dbfx.Exec(t, `UPDATE kb_annotation SET status = $2 WHERE id = $1`, resolved, kb.AnnotationStatusResolved)

	// The merged page: the heading is gone, the sentence is reworded.
	next := []kb.Block{
		{ID: b2, Kind: kb.BlockKindText, Content: "渠道回调改为按渠道交易号去重。幂等键在 Redis 中保存 24 小时。"},
		{ID: b3, Kind: kb.BlockKindText, Content: "重复回调直接返回成功。"},
	}
	changed, err := kb.RelocateAnnotations(ctx, testHandler.Queries, parseUUID(f.base), map[pgtype.UUID][]kb.Block{parseUUID(f.page): next})
	if err != nil {
		t.Fatalf("RelocateAnnotations: %+v", err)
	}
	if len(changed) != 3 {
		t.Errorf("changed %d annotations, want 3 (kept one refreshes its context, resolved one is skipped)", len(changed))
	}

	got := annotationIDs(listKbAnnotations(t, f.slug, "status=all", http.StatusOK))
	if a := got[kept]; a.BlockID != b3 || a.AnchorLost || a.OriginalQuote != "" || a.Prefix == "" {
		t.Errorf("kept = %+v", a)
	}
	if a := got[rewritten]; a.BlockID != b2 || a.Quote != "渠道回调改为按渠道交易号去重。" || a.OriginalQuote != "渠道回调按订单号加幂等键去重。" || a.AnchorLost {
		t.Errorf("rewritten = %+v", a)
	}
	if a := got[lost]; !a.AnchorLost || a.BlockID != "" || a.Quote != "去重" || a.BlockIndex != 0 {
		t.Errorf("lost = %+v", a)
	}
	if a := got[resolved]; a.Prefix == "" || a.BlockID != b2 {
		t.Errorf("resolved annotation was touched: %+v", a)
	}

	// Relocating again with the same body changes nothing.
	again, err := kb.RelocateAnnotations(ctx, testHandler.Queries, parseUUID(f.base), map[pgtype.UUID][]kb.Block{parseUUID(f.page): next})
	if err != nil || len(again) != 0 {
		t.Errorf("second relocation changed %d annotations (%v), want 0", len(again), err)
	}
}
