package handler

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/testutil"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// kbReviewFixture is a knowledge base with two pages: Callback (a title, a
// heading, two paragraphs) and B.
type kbReviewFixture struct {
	baseID, slug string
	pageA, pageB string
	// blocks are Callback's block ids: title, heading, dedup, retry.
	blocks []string
}

func newKbReviewFixture(t *testing.T) kbReviewFixture {
	t.Helper()

	slug := fmt.Sprintf("review-%d", time.Now().UnixNano())
	base := insertTestKbBase(t, "Review KB", slug)
	pageA := createTestKbPage(t, base, kb.NewPage{
		Slug: "callback", Title: "Callback", Position: "a0",
		Frontmatter: map[string]any{"type": "Workflow", "title": "Callback", "description": "d"},
		Markdown:    "# Callback\n\n## Dedup\n\nDedup by order id.\n\nRetry every minute.",
	})
	pageB := createTestKbPage(t, base, kb.NewPage{
		Slug: "b", Title: "B", Position: "a1",
		Frontmatter: map[string]any{"type": "Guide", "title": "B", "description": "d"},
		Markdown:    "B body links [callback](/callback.md).",
	})
	dbfx.Cleanup(t, `DELETE FROM kb_mr_comment WHERE merge_request_id IN (SELECT id FROM kb_merge_request WHERE knowledge_base_id = $1)`, base)
	dbfx.Cleanup(t, `DELETE FROM kb_base WHERE id = $1`, base)

	return kbReviewFixture{
		baseID: base, slug: slug, pageA: pageA, pageB: pageB,
		blocks: blockIDsOf(t, kbFetch(t, pageA, "detail=with-ids", http.StatusOK)),
	}
}

// draftWith opens a draft and replaces Callback's blocks with the given
// contents (block index → Markdown).
func (f kbReviewFixture) draftWith(t *testing.T, edits map[int]string) string {
	t.Helper()

	draftID := createKbDraftAs(t, f.slug, nil)
	ops := make([]map[string]any, 0, len(edits))
	for i, content := range edits {
		ops = append(ops, map[string]any{"op": kb.OpBlockReplace, "block": f.blocks[i], "content": content})
	}
	kbOps(t, draftID, f.pageA, kbPageHead(t, f.pageA), http.StatusOK, ops...)

	return draftID
}

func openKbMR(t *testing.T, draftID string, annotationIDs ...string) KbMergeRequestResponse {
	t.Helper()

	if annotationIDs == nil {
		annotationIDs = []string{}
	}
	req := newRequest(http.MethodPost, "/api/kb/merge-requests", map[string]any{
		"draft_id": draftID, "title": "Change " + draftID[:8], "summary": "s", "annotation_ids": annotationIDs,
	})
	var got KbMergeRequestResponse
	testutil.Call(t, testHandler.CreateKbMergeRequest, req).Want(http.StatusCreated).JSON(&got)

	return got
}

func kbMRRequest(method string, number int, body any, mutate func(*http.Request)) *http.Request {
	req := testutil.WithURLParams(newRequest(method, "/api/kb/merge-requests/x", body), "number", strconv.Itoa(number))
	if mutate != nil {
		mutate(req)
	}

	return req
}

func getKbMR(t *testing.T, number int, mutate func(*http.Request)) KbMergeRequestDetailResponse {
	t.Helper()

	var got KbMergeRequestDetailResponse
	testutil.Call(t, testHandler.GetKbMergeRequest, kbMRRequest(http.MethodGet, number, nil, mutate)).Want(http.StatusOK).JSON(&got)

	return got
}

func mergeKbMR(t *testing.T, number int, version int64, mutate func(*http.Request), want int) map[string]any {
	t.Helper()

	req := kbMRRequest(http.MethodPost, number, map[string]any{"draft_version": version}, mutate)

	return testutil.Call(t, testHandler.MergeKbMergeRequest, req).Want(want).Map()
}

func asMember(userID string) func(*http.Request) {
	return func(r *http.Request) { r.Header.Set("X-User-ID", userID) }
}

func kbBlockContent(t *testing.T, pageID, blockID string) string {
	t.Helper()

	var content string
	dbfx.QueryRow(t, `SELECT COALESCE((SELECT b->>'content' FROM kb_page, jsonb_array_elements(blocks) b WHERE id = $1 AND b->>'id' = $2), '')`, pageID, blockID).Scan(&content)

	return content
}

// TestKbMergeRequestMerge merges a draft that edits a page and adds one:
// the mainline gets new revisions, links, claims and search text in one go,
// the annotation it handles is resolved and follows its sentence, and the
// draft and merge request end merged.
func TestKbMergeRequestMerge(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbReviewFixture(t)
	mergedEvents := recordKbEvents(protocol.EventKbMrMerged, f.baseID)
	annotation := dbfx.Insert(t, "kb_annotation", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": f.baseID, "page_id": f.pageA,
		"block_id": f.blocks[2], "quote": "Dedup by order id.", "body": "It is the trade no now.",
		"author_type": kbActorMember, "author_id": testUserID,
	})

	draftID := f.draftWith(t, map[int]string{2: "Retry every minute.\n\nDedup by order id and trade no."})
	created := kbDraftCreatePage(t, draftID, map[string]any{
		"parent": f.slug + ":/", "slug": "manual",
		"frontmatter": map[string]any{"type": "Guide", "title": "Manual", "description": "d"},
		"content":     "# Manual\n\nSee [callback](/callback.md) and [b](/b.md).",
	})
	newPage, _ := created["page_id"].(string)
	if newPage == "" {
		t.Fatalf("created page = %v", created)
	}

	mr := openKbMR(t, draftID, annotation)
	detail := getKbMR(t, mr.Number, nil)
	if len(detail.Pages) != 2 || !detail.CanMerge || !detail.CanClose || detail.KnowledgeBaseSlug != f.slug ||
		len(detail.Checks.Conflicts) != 0 || detail.Origin.Type != kbOriginNone || detail.DraftVersion != 2 {
		t.Fatalf("detail = %+v", detail)
	}
	if !strings.HasPrefix(detail.Mention, fmt.Sprintf("[#%d Change", mr.Number)) {
		t.Errorf("mention = %q", detail.Mention)
	}

	// A version the reviewer did not see is refused.
	if got := mergeKbMR(t, mr.Number, 1, nil, http.StatusConflict); got["code"] != kbCodeStaleDraftVersion || got["draft_version"] != float64(2) {
		t.Errorf("stale merge = %v", got)
	}

	oldHead := kbPageHead(t, f.pageA)
	got := mergeKbMR(t, mr.Number, detail.DraftVersion, nil, http.StatusOK)
	if got["status"] != kb.MergeRequestStatusMerged || got["merged_by"] != testUserID || got["merged_by_name"] == "" {
		t.Fatalf("merge = %v", got)
	}

	var prev, mergeRequest, searchText, generatedBy string
	newHead := kbPageHead(t, f.pageA)
	dbfx.QueryRow(t, `SELECT prev_revision_id::text, merge_request_id::text FROM kb_page_revision WHERE id = $1`, newHead).Scan(&prev, &mergeRequest)
	if prev != oldHead || mergeRequest != mr.ID {
		t.Errorf("revision prev=%s mr=%s, want %s %s", prev, mergeRequest, oldHead, mr.ID)
	}
	dbfx.QueryRow(t, `SELECT search_text, frontmatter->'generated'->>'by' FROM kb_page WHERE id = $1`, f.pageA).Scan(&searchText, &generatedBy)
	if !strings.Contains(searchText, "trade no") || generatedBy == "" {
		t.Errorf("search_text %q, generated.by %q", searchText, generatedBy)
	}

	var links int
	dbfx.QueryRow(t, `SELECT count(*) FROM kb_link WHERE from_page_id = $1 AND to_page_id IN ($2, $3)`, newPage, f.pageA, f.pageB).Scan(&links)
	if links != 2 {
		t.Errorf("new page links = %d, want 2", links)
	}
	var title string
	dbfx.QueryRow(t, `SELECT title FROM kb_page WHERE id = $1 AND deleted_at IS NULL`, newPage).Scan(&title)
	if title != "Manual" {
		t.Errorf("new page title = %q", title)
	}

	var status, blockID, mrOf string
	dbfx.QueryRow(t, `SELECT status, block_id, merge_request_id::text FROM kb_annotation WHERE id = $1`, annotation).Scan(&status, &blockID, &mrOf)
	if status != kb.AnnotationStatusResolved || mrOf != mr.ID || blockID == "" || blockID == f.blocks[2] {
		t.Errorf("annotation status=%s block=%q mr=%s", status, blockID, mrOf)
	}
	var draftStatus string
	var contentVersion int64
	dbfx.QueryRow(t, `SELECT status FROM kb_draft WHERE id = $1`, draftID).Scan(&draftStatus)
	dbfx.QueryRow(t, `SELECT content_version FROM kb_base WHERE id = $1`, f.baseID).Scan(&contentVersion)
	if draftStatus != kb.DraftStatusMerged || contentVersion != 1 {
		t.Errorf("draft %s, content_version %d", draftStatus, contentVersion)
	}
	if events := mergedEvents.all(); len(events) != 1 || len(events[0]["page_ids"].([]string)) != 2 {
		t.Errorf("kb.mr.merged = %v", events)
	}

	// Merged once is merged for good.
	if got := mergeKbMR(t, mr.Number, detail.DraftVersion, nil, http.StatusConflict); got["code"] != kbCodeMergeRequestNotOpen {
		t.Errorf("second merge = %v", got)
	}

	// The change log lists it, and only it.
	var log []KbMergeRequestResponse
	req := newRequest(http.MethodGet, "/api/kb/merge-requests?status=merged&kb="+f.slug, nil)
	testutil.Call(t, testHandler.ListKbMergeRequests, req).Want(http.StatusOK).JSON(&log)
	if len(log) != 1 || log[0].Number != mr.Number {
		t.Errorf("change log = %+v", log)
	}
}

func kbDraftCreatePage(t *testing.T, draftID string, body map[string]any) map[string]any {
	t.Helper()

	req := testutil.WithURLParams(newRequest(http.MethodPost, "/api/kb/drafts/x/pages", body), "draftId", draftID)

	return testutil.Call(t, testHandler.CreateKbDraftPage, req).Want(http.StatusCreated).Map()
}

// TestKbMergeThreeWay merges two drafts that changed different blocks of
// the same page one after the other, then refuses a third that changed a
// block the mainline moved on from.
func TestKbMergeThreeWay(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbReviewFixture(t)
	first := openKbMR(t, f.draftWith(t, map[int]string{2: "Dedup by trade no."}))
	second := openKbMR(t, f.draftWith(t, map[int]string{3: "Retry every five minutes."}))
	third := openKbMR(t, f.draftWith(t, map[int]string{2: "Dedup by idempotency key."}))

	mergeKbMR(t, first.Number, first.DraftVersion, nil, http.StatusOK)

	// The second draft is based on the old head; its block merges cleanly.
	mergeKbMR(t, second.Number, second.DraftVersion, nil, http.StatusOK)
	if kbBlockContent(t, f.pageA, f.blocks[2]) != "Dedup by trade no." || kbBlockContent(t, f.pageA, f.blocks[3]) != "Retry every five minutes." {
		t.Errorf("after two merges: %q / %q", kbBlockContent(t, f.pageA, f.blocks[2]), kbBlockContent(t, f.pageA, f.blocks[3]))
	}

	// The third changed the block the first merge changed: the review page
	// shows the conflict before merging, and merging is refused whole.
	detail := getKbMR(t, third.Number, nil)
	if len(detail.Checks.Conflicts) != 1 || detail.Checks.Conflicts[0].BlockID != f.blocks[2] || detail.Checks.Conflicts[0].MainLines == "" {
		t.Fatalf("trial merge conflicts = %+v", detail.Checks.Conflicts)
	}
	head := kbPageHead(t, f.pageA)
	got := mergeKbMR(t, third.Number, third.DraftVersion, nil, http.StatusConflict)
	if got["code"] != kbCodeMergeConflict || len(got["conflicts"].([]any)) != 1 {
		t.Errorf("conflicting merge = %v", got)
	}
	if kbPageHead(t, f.pageA) != head {
		t.Error("a refused merge moved the mainline")
	}
	var status string
	dbfx.QueryRow(t, `SELECT status FROM kb_merge_request WHERE id = $1`, third.ID).Scan(&status)
	if status != kb.MergeRequestStatusOpen {
		t.Errorf("refused merge request is %s, want open", status)
	}
}

// TestKbMergeConcurrent merges the same request from several requests at
// once, and two requests that changed the same block at once: exactly one
// merge goes through each time.
func TestKbMergeConcurrent(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbReviewFixture(t)
	race := func(calls ...func() int) map[int]int {
		var wg sync.WaitGroup
		var mu sync.Mutex
		codes := map[int]int{}
		for _, call := range calls {
			wg.Add(1)
			go func() {
				defer wg.Done()
				code := call()
				mu.Lock()
				codes[code]++
				mu.Unlock()
			}()
		}
		wg.Wait()

		return codes
	}
	merge := func(mr KbMergeRequestResponse) func() int {
		return func() int {
			req := kbMRRequest(http.MethodPost, mr.Number, map[string]any{"draft_version": mr.DraftVersion}, nil)
			return testutil.Call(t, testHandler.MergeKbMergeRequest, req).Code
		}
	}

	same := openKbMR(t, f.draftWith(t, map[int]string{2: "Dedup by trade no."}))
	if codes := race(merge(same), merge(same), merge(same), merge(same)); codes[http.StatusOK] != 1 || codes[http.StatusConflict] != 3 {
		t.Errorf("same request merged concurrently: %v", codes)
	}
	var revisions int
	dbfx.QueryRow(t, `SELECT count(*) FROM kb_page_revision WHERE merge_request_id = $1`, same.ID).Scan(&revisions)
	if revisions != 1 {
		t.Errorf("revisions written = %d, want 1", revisions)
	}

	a := openKbMR(t, f.draftWith(t, map[int]string{3: "Retry hourly."}))
	b := openKbMR(t, f.draftWith(t, map[int]string{3: "Retry daily."}))
	if codes := race(merge(a), merge(b)); codes[http.StatusOK] != 1 || codes[http.StatusConflict] != 1 {
		t.Errorf("two requests on one block: %v", codes)
	}
	if got := kbBlockContent(t, f.pageA, f.blocks[3]); got != "Retry hourly." && got != "Retry daily." {
		t.Errorf("block after the race = %q", got)
	}
}

// TestKbMergeRequestPermissions: merging and reverting need the knowledge
// base creator or an owner or admin; closing also lets the author in.
func TestKbMergeRequestPermissions(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbReviewFixture(t)
	plain := createPlainMember(t, fmt.Sprintf("kb-review-%d@marvis.ai", time.Now().UnixNano()))
	creator := createPlainMember(t, fmt.Sprintf("kb-review-creator-%d@marvis.ai", time.Now().UnixNano()))
	dbfx.Exec(t, `UPDATE kb_base SET created_by = $2 WHERE id = $1`, f.baseID, creator)

	mr := openKbMR(t, f.draftWith(t, map[int]string{2: "Dedup by trade no."}))
	if detail := getKbMR(t, mr.Number, asMember(plain)); detail.CanMerge || detail.CanClose || detail.CanRevert {
		t.Errorf("plain member may = %+v", detail)
	}
	if got := mergeKbMR(t, mr.Number, mr.DraftVersion, asMember(plain), http.StatusForbidden); got["code"] != kbCodeForbidden {
		t.Errorf("plain member merge = %v", got)
	}
	closeReq := kbMRRequest(http.MethodPost, mr.Number, map[string]any{}, asMember(plain))
	testutil.Call(t, testHandler.CloseKbMergeRequest, closeReq).Want(http.StatusForbidden)

	// The knowledge base creator merges without being an admin.
	if detail := getKbMR(t, mr.Number, asMember(creator)); !detail.CanMerge || !detail.CanClose {
		t.Errorf("creator may = %+v", detail)
	}
	mergeKbMR(t, mr.Number, mr.DraftVersion, asMember(creator), http.StatusOK)
	revertReq := kbMRRequest(http.MethodPost, mr.Number, nil, asMember(plain))
	testutil.Call(t, testHandler.RevertKbMergeRequest, revertReq).Want(http.StatusForbidden)

	// The author closes their own request; an agent counts as the person
	// its token is bound to.
	plainBase := insertTestKbBase(t, "Plain", fmt.Sprintf("plain-%d", time.Now().UnixNano()), testutil.Cols{"created_by": creator})
	page := createTestKbPage(t, plainBase, kb.NewPage{Slug: "p", Title: "P", Frontmatter: map[string]any{"type": "Guide", "title": "P", "description": "d"}, Markdown: "P body"})
	var draft KbDraftResponse
	testutil.Call(t, testHandler.CreateKbDraft, newRequestAs(plain, http.MethodPost, "/api/kb/drafts", map[string]any{"knowledge_base": plainBase})).Want(http.StatusCreated).JSON(&draft)
	opsReq := testutil.WithURLParams(newRequestAs(plain, http.MethodPost, "/api/kb/drafts/x/pages/x/ops", map[string]any{
		"version": kbPageHead(t, page), "ops": []map[string]any{{"op": kb.OpAppend, "content": "More."}},
	}), "draftId", draft.ID, "id", page)
	testutil.Call(t, testHandler.ApplyKbPageOps, opsReq).Want(http.StatusOK)
	var own KbMergeRequestResponse
	testutil.Call(t, testHandler.CreateKbMergeRequest, newRequestAs(plain, http.MethodPost, "/api/kb/merge-requests", map[string]any{
		"draft_id": draft.ID, "title": "Mine",
	})).Want(http.StatusCreated).JSON(&own)
	if got := mergeKbMR(t, own.Number, own.DraftVersion, asMember(plain), http.StatusForbidden); got["code"] != kbCodeForbidden {
		t.Errorf("author merge = %v", got)
	}
	closed := testutil.Call(t, testHandler.CloseKbMergeRequest, kbMRRequest(http.MethodPost, own.Number, map[string]any{"reason": "not needed"}, asMember(plain))).Want(http.StatusOK).Map()
	if closed["status"] != kb.MergeRequestStatusClosed || closed["close_reason"] != "not needed" || closed["closed_by"] != plain {
		t.Errorf("author close = %v", closed)
	}
}

// TestKbMergeRequestClose: closing puts the handled annotations back in the
// queue and opens the draft again; a closed request cannot be merged.
func TestKbMergeRequestClose(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbReviewFixture(t)
	closedEvents := recordKbEvents(protocol.EventKbMrClosed, f.baseID)
	annotation := dbfx.Insert(t, "kb_annotation", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": f.baseID, "page_id": f.pageA, "body": "b",
		"author_type": kbActorMember, "author_id": testUserID,
	})
	draftID := f.draftWith(t, map[int]string{2: "Dedup by trade no."})
	mr := openKbMR(t, draftID, annotation)

	testutil.Call(t, testHandler.CloseKbMergeRequest, kbMRRequest(http.MethodPost, mr.Number, nil, nil)).Want(http.StatusOK)

	var annotationStatus, draftStatus string
	dbfx.QueryRow(t, `SELECT status FROM kb_annotation WHERE id = $1`, annotation).Scan(&annotationStatus)
	dbfx.QueryRow(t, `SELECT status FROM kb_draft WHERE id = $1`, draftID).Scan(&draftStatus)
	if annotationStatus != kb.AnnotationStatusPending || draftStatus != kb.DraftStatusOpen {
		t.Errorf("after close: annotation %s, draft %s", annotationStatus, draftStatus)
	}
	if len(closedEvents.all()) != 1 {
		t.Errorf("kb.mr.closed = %v", closedEvents.all())
	}
	if got := mergeKbMR(t, mr.Number, mr.DraftVersion, nil, http.StatusConflict); got["code"] != kbCodeMergeRequestNotOpen {
		t.Errorf("merge after close = %v", got)
	}
	testutil.Call(t, testHandler.CloseKbMergeRequest, kbMRRequest(http.MethodPost, mr.Number, nil, nil)).Want(http.StatusConflict)

	// The reopened draft can be submitted again.
	again := openKbMR(t, draftID)
	if again.Number == mr.Number || again.Status != kb.MergeRequestStatusOpen {
		t.Errorf("resubmitted = %+v", again)
	}
}

// TestKbRevert reverts a merge that edited a page and added one: the revert
// is a new merge request whose merge restores the block and deletes the
// added page. A later change to the same block makes the revert conflict.
func TestKbRevert(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbReviewFixture(t)
	draftID := f.draftWith(t, map[int]string{2: "Dedup by trade no."})
	created := kbDraftCreatePage(t, draftID, map[string]any{
		"parent": f.slug + ":/", "slug": "manual",
		"frontmatter": map[string]any{"type": "Guide", "title": "Manual", "description": "d"}, "content": "# Manual\n\nSee [b](/b.md).",
	})
	newPage, _ := created["page_id"].(string)
	mr := openKbMR(t, draftID)
	mergeKbMR(t, mr.Number, mr.DraftVersion, nil, http.StatusOK)

	// Only merged requests revert.
	open := openKbMR(t, f.draftWith(t, map[int]string{3: "Retry hourly."}))
	if got := testutil.Call(t, testHandler.RevertKbMergeRequest, kbMRRequest(http.MethodPost, open.Number, nil, nil)).Want(http.StatusConflict).Map(); got["code"] != kbCodeMergeRequestNotMerged {
		t.Errorf("revert an open request = %v", got)
	}
	testutil.Call(t, testHandler.CloseKbMergeRequest, kbMRRequest(http.MethodPost, open.Number, nil, nil)).Want(http.StatusOK)

	var revert KbMergeRequestResponse
	testutil.Call(t, testHandler.RevertKbMergeRequest, kbMRRequest(http.MethodPost, mr.Number, nil, nil)).Want(http.StatusCreated).JSON(&revert)
	if revert.Source != kb.MergeRequestSourceRevert || revert.Reverts == nil || *revert.Reverts != mr.Number ||
		revert.Origin.Type != kbOriginRevert || revert.Title != fmt.Sprintf("Revert #%d: %s", mr.Number, mr.Title) || revert.DraftVersion != 1 {
		t.Fatalf("revert = %+v", revert)
	}
	detail := getKbMR(t, revert.Number, nil)
	changes := map[string]string{}
	for _, p := range detail.Pages {
		changes[p.PageID] = p.Change
	}
	if changes[f.pageA] != kb.DraftChangeModified || changes[newPage] != kb.DraftChangeDeleted {
		t.Errorf("revert pages = %v", changes)
	}

	mergeKbMR(t, revert.Number, revert.DraftVersion, nil, http.StatusOK)
	if got := kbBlockContent(t, f.pageA, f.blocks[2]); got != "Dedup by order id." {
		t.Errorf("reverted block = %q", got)
	}
	var deleted bool
	dbfx.QueryRow(t, `SELECT deleted_at IS NOT NULL FROM kb_page WHERE id = $1`, newPage).Scan(&deleted)
	if !deleted {
		t.Error("the page the reverted request added is still live")
	}

	// Reverting again finds nothing left to undo... of the revert's target.
	if got := testutil.Call(t, testHandler.RevertKbMergeRequest, kbMRRequest(http.MethodPost, mr.Number, nil, nil)).Want(http.StatusConflict).Map(); got["code"] != kbCodeNothingToRevert {
		t.Errorf("second revert = %v", got)
	}

	// A later change to the same block conflicts.
	edit := openKbMR(t, f.draftWith(t, map[int]string{3: "Retry hourly."}))
	mergeKbMR(t, edit.Number, edit.DraftVersion, nil, http.StatusOK)
	later := openKbMR(t, f.draftWith(t, map[int]string{3: "Retry daily."}))
	mergeKbMR(t, later.Number, later.DraftVersion, nil, http.StatusOK)
	got := testutil.Call(t, testHandler.RevertKbMergeRequest, kbMRRequest(http.MethodPost, edit.Number, nil, nil)).Want(http.StatusConflict).Map()
	if got["code"] != kbCodeRevertConflict || len(got["conflicts"].([]any)) != 1 {
		t.Errorf("conflicting revert = %v", got)
	}
}

// TestKbMergeRequestList filters by status and knowledge base.
func TestKbMergeRequestList(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbReviewFixture(t)
	openMR := openKbMR(t, f.draftWith(t, map[int]string{2: "a"}))
	closedMR := openKbMR(t, f.draftWith(t, map[int]string{3: "b"}))
	testutil.Call(t, testHandler.CloseKbMergeRequest, kbMRRequest(http.MethodPost, closedMR.Number, nil, nil)).Want(http.StatusOK)

	list := func(query string) []int {
		var got []KbMergeRequestResponse
		req := newRequest(http.MethodGet, "/api/kb/merge-requests?kb="+url.QueryEscape(f.slug)+"&"+query, nil)
		testutil.Call(t, testHandler.ListKbMergeRequests, req).Want(http.StatusOK).JSON(&got)
		numbers := make([]int, len(got))
		for i, mr := range got {
			numbers[i] = mr.Number
		}

		return numbers
	}

	if got := list(""); len(got) != 1 || got[0] != openMR.Number {
		t.Errorf("default (open) = %v", got)
	}
	if got := list("status=closed"); len(got) != 1 || got[0] != closedMR.Number {
		t.Errorf("closed = %v", got)
	}
	if got := list("status=all"); len(got) != 2 {
		t.Errorf("all = %v", got)
	}
	if got := list("status=merged,closed"); len(got) != 1 {
		t.Errorf("ended = %v", got)
	}
	if got := list("status=all&limit=1&offset=1"); len(got) != 1 {
		t.Errorf("paged = %v", got)
	}
	testutil.Call(t, testHandler.ListKbMergeRequests, newRequest(http.MethodGet, "/api/kb/merge-requests?status=bogus", nil)).Want(http.StatusBadRequest)

	// Editing the text of an open request.
	patch := kbMRRequest(http.MethodPatch, openMR.Number, map[string]any{"title": "Renamed", "risk": "high"}, nil)
	updated := testutil.Call(t, testHandler.UpdateKbMergeRequest, patch).Want(http.StatusOK).Map()
	if updated["title"] != "Renamed" || updated["risk"] != "high" || updated["summary"] != "s" {
		t.Errorf("updated = %v", updated)
	}
}
