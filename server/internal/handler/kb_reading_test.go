package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/testutil"
)

// kbTestBlocks renders blocks as stored: pairs of block id and content.
func kbTestBlocks(t *testing.T, pairs ...string) string {
	t.Helper()

	blocks := make([]kb.Block, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		blocks = append(blocks, kb.Block{ID: pairs[i], Kind: kb.BlockKindText, Content: pairs[i+1]})
	}
	raw, err := json.Marshal(blocks)
	if err != nil {
		t.Fatal(err)
	}

	return string(raw)
}

// mergeTestKbRevision records a merged merge request that replaced a page's
// body and moves the page head to the new revision.
func mergeTestKbRevision(t *testing.T, baseID, pageID string, number int, title, blocks string, mergedAt time.Time) string {
	t.Helper()

	mrID := dbfx.Insert(t, "kb_merge_request", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": baseID, "number": number, "title": title,
		"source": "ingest", "author_type": "member", "author_id": testUserID,
		"draft_id": testutil.Raw("gen_random_uuid()"), "status": kb.MergeRequestStatusMerged,
		"merged_by": testUserID, "merged_at": mergedAt,
		"annotation_ids": testutil.Raw("ARRAY[gen_random_uuid()]"),
	})

	var revisionID string
	dbfx.QueryRow(t, `
		INSERT INTO kb_page_revision (workspace_id, knowledge_base_id, page_id, prev_revision_id, merge_request_id,
			parent_id, position, slug, frontmatter, blocks, claims, created_at)
		SELECT workspace_id, knowledge_base_id, id, head_revision_id, $2, parent_id, position, slug, frontmatter, $3::jsonb, '[]', $4
		FROM kb_page WHERE id = $1
		RETURNING id`, pageID, mrID, blocks, mergedAt).Scan(&revisionID)
	dbfx.Exec(t, `UPDATE kb_page SET blocks = $2::jsonb, head_revision_id = $3 WHERE id = $1`, pageID, blocks, revisionID)

	return revisionID
}

// insertTestKbDraft creates a draft of the base owned by createdBy.
func insertTestKbDraft(t *testing.T, baseID, createdBy string, version int) string {
	t.Helper()

	return dbfx.Insert(t, "kb_draft", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": baseID, "title": "draft",
		"version": version, "created_by": createdBy,
	})
}

// insertTestKbDraftPage records a draft's copy of a page.
func insertTestKbDraftPage(t *testing.T, draftID, pageID, op, parentID, position, slug, title, blocks string) {
	t.Helper()

	var parent any
	if parentID != "" {
		parent = parentID
	}
	dbfx.InsertNoID(t, "kb_draft_page", testutil.Cols{
		"draft_id": draftID, "page_id": pageID, "op": op, "parent_id": parent, "position": position,
		"slug": slug, "frontmatter": fmt.Sprintf(`{"type":"Guide","title":%q,"description":"d"}`, title),
		"blocks": blocks, "claims": "[]",
	}, "draft_id = $1 AND page_id = $2", draftID, pageID)
}

func listKbLevel(t *testing.T, baseRef, query string, want int) KbTreeLevelResponse {
	t.Helper()

	req := withURLParam(newRequest(http.MethodGet, "/api/kb/bases/"+baseRef+"/pages?"+query, nil), "kb", baseRef)
	var got KbTreeLevelResponse
	rec := testutil.Call(t, testHandler.ListKbPages, req).Want(want)
	if want == http.StatusOK {
		rec.JSON(&got)
	}

	return got
}

func kbLevelTitles(level KbTreeLevelResponse) string {
	titles := make([]string, len(level.Pages))
	for i, page := range level.Pages {
		titles[i] = page.Title
		if page.DraftChange != "" {
			titles[i] += "(" + page.DraftChange + ")"
		}
	}

	return strings.Join(titles, ",")
}

func TestListKbPagesLevels(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	slug := fmt.Sprintf("tree-%d", time.Now().UnixNano())
	base := insertTestKbBase(t, "Tree KB", slug)
	overdue := time.Now().Add(-time.Hour)
	createTestKbPage(t, base, kb.NewPage{Slug: "a", Title: "A", Position: "a0", Markdown: "a", StaleAfter: &overdue})
	b := createTestKbPage(t, base, kb.NewPage{Slug: "b", Title: "B", Position: "a1", Markdown: "b"})
	b1 := createTestKbPage(t, base, kb.NewPage{ParentID: b, Slug: "b1", Title: "B1", Position: "a0", Markdown: "b1"})
	createTestKbPage(t, base, kb.NewPage{ParentID: b, Slug: "b2", Title: "B2", Position: "a1", Markdown: "b2"})
	dbfx.InsertNoID(t, "kb_annotation", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "page_id": b1, "body": "check",
		"author_type": "member", "author_id": testUserID,
	}, "knowledge_base_id = $1", base)

	first := listKbLevel(t, slug, "limit=1", http.StatusOK)
	if kbLevelTitles(first) != "A" || first.NextCursor == "" || first.Parent != nil {
		t.Fatalf("first page = %s next=%q parent=%v, want A with a cursor", kbLevelTitles(first), first.NextCursor, first.Parent)
	}
	if !first.Pages[0].Stale || first.Pages[0].HasChild || first.Pages[0].Path != "/a" {
		t.Errorf("A = %+v, want stale leaf at /a", first.Pages[0])
	}

	second := listKbLevel(t, slug, "limit=1&cursor="+url.QueryEscape(first.NextCursor), http.StatusOK)
	if kbLevelTitles(second) != "B" {
		t.Fatalf("second page = %s, want B", kbLevelTitles(second))
	}
	if p := second.Pages[0]; !p.HasChild || p.ChildCount != 2 {
		t.Errorf("B = %+v, want 2 children", p)
	}
	if second.NextCursor != "" {
		t.Errorf("last page next_cursor = %q, want empty", second.NextCursor)
	}

	for _, parent := range []string{b, slug + ":/b", "/b"} {
		children := listKbLevel(t, slug, "parent="+url.QueryEscape(parent), http.StatusOK)
		if kbLevelTitles(children) != "B1,B2" || children.Parent == nil || children.Parent.Path != "/b" || children.Parent.Title != "B" {
			t.Fatalf("children of %s = %s parent=%+v", parent, kbLevelTitles(children), children.Parent)
		}
		if children.Pages[0].OpenAnnotations != 1 || children.Pages[0].Path != "/b/b1" {
			t.Errorf("B1 = %+v, want 1 open annotation at /b/b1", children.Pages[0])
		}
	}

	listKbLevel(t, slug, "limit=0", http.StatusBadRequest)
	listKbLevel(t, slug, "limit=201", http.StatusBadRequest)
	listKbLevel(t, slug, "cursor=garbage", http.StatusBadRequest)
	listKbLevel(t, slug, "parent=/missing", http.StatusNotFound)
	listKbLevel(t, slug, "parent=not-a-uuid", http.StatusBadRequest)
}

func TestListKbPagesDraftOverlay(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	slug := fmt.Sprintf("overlay-%d", time.Now().UnixNano())
	base := insertTestKbBase(t, "Overlay KB", slug)
	a := createTestKbPage(t, base, kb.NewPage{Slug: "a", Title: "A", Position: "a0", Markdown: "a"})
	b := createTestKbPage(t, base, kb.NewPage{Slug: "b", Title: "B", Position: "a1", Markdown: "b"})
	b1 := createTestKbPage(t, base, kb.NewPage{ParentID: b, Slug: "b1", Title: "B1", Position: "a0", Markdown: "b1"})
	b2 := createTestKbPage(t, base, kb.NewPage{ParentID: b, Slug: "b2", Title: "B2", Position: "a1", Markdown: "b2"})

	draft := insertTestKbDraft(t, base, testUserID, 4)
	insertTestKbDraftPage(t, draft, a, kb.DraftOpDelete, "", "a0", "a", "A", kbTestBlocks(t))
	insertTestKbDraftPage(t, draft, b1, kb.DraftOpUpdate, b, "a0", "b1", "B1 edited", kbTestBlocks(t, "bX01", "new"))
	insertTestKbDraftPage(t, draft, b2, kb.DraftOpMove, "", "a3", "b2", "B2", kbTestBlocks(t))
	added := "6a3c0a52-6f0e-4bb5-9c62-0d1f2e3a4b5c"
	insertTestKbDraftPage(t, draft, added, kb.DraftOpCreate, "", "a2", "n", "N", kbTestBlocks(t))

	mainline := listKbLevel(t, slug, "", http.StatusOK)
	if kbLevelTitles(mainline) != "A,B" || mainline.Pages[1].ChildCount != 2 {
		t.Fatalf("mainline top level = %s (B children %d), want A,B with 2", kbLevelTitles(mainline), mainline.Pages[1].ChildCount)
	}

	top := listKbLevel(t, slug, "draft="+draft, http.StatusOK)
	if got := kbLevelTitles(top); got != "A(deleted),B,N(added),B2(moved)" {
		t.Fatalf("draft top level = %s", got)
	}
	if top.Pages[1].ChildCount != 1 {
		t.Errorf("B children with draft = %d, want 1 (B2 moved out)", top.Pages[1].ChildCount)
	}
	if top.Pages[3].Path != "/b2" {
		t.Errorf("moved page path = %q, want /b2", top.Pages[3].Path)
	}

	// Paging across the merged level neither repeats nor drops pages.
	seen := []string{}
	cursor := ""
	for i := 0; i < 5; i++ {
		page := listKbLevel(t, slug, "limit=1&draft="+draft+"&cursor="+url.QueryEscape(cursor), http.StatusOK)
		seen = append(seen, kbLevelTitles(page))
		cursor = page.NextCursor
		if cursor == "" {
			break
		}
	}
	if got := strings.Join(seen, ","); got != "A(deleted),B,N(added),B2(moved)" {
		t.Errorf("paged draft level = %s", got)
	}

	children := listKbLevel(t, slug, "parent="+b+"&draft="+draft, http.StatusOK)
	if kbLevelTitles(children) != "B1 edited(modified)" {
		t.Errorf("draft children of B = %s", kbLevelTitles(children))
	}

	other := newRequestAs("6a3c0a52-0000-4bb5-9c62-0d1f2e3a4b5c", http.MethodGet, "/api/kb/bases/"+slug+"/pages?draft="+draft, nil)
	testutil.Call(t, testHandler.ListKbPages, withURLParam(other, "kb", slug)).Want(http.StatusForbidden)
}

func TestListKbPagesNamesDraftDeletedPageByMainline(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	slug := fmt.Sprintf("overlay-del-%d", time.Now().UnixNano())
	base := insertTestKbBase(t, "Overlay KB", slug)
	disco := createTestKbPage(t, base, kb.NewPage{Slug: "discovery", Title: "服务发现", Position: "a0", Markdown: "d"})

	// A deletion merged in from the mainline leaves the draft row without a header.
	draft := insertTestKbDraft(t, base, testUserID, 2)
	dbfx.InsertNoID(t, "kb_draft_page", testutil.Cols{
		"draft_id": draft, "page_id": disco, "op": kb.DraftOpDelete, "parent_id": nil, "position": "a0",
		"slug": "discovery", "frontmatter": "{}", "blocks": "[]", "claims": "[]",
	}, "draft_id = $1 AND page_id = $2", draft, disco)

	top := listKbLevel(t, slug, "draft="+draft, http.StatusOK)
	if got := kbLevelTitles(top); got != "服务发现(deleted)" {
		t.Fatalf("draft top level = %s, want the deleted page under its mainline title", got)
	}
}

func getKbPage(t *testing.T, ref, query string, want int) KbPageResponse {
	t.Helper()

	escaped := url.PathEscape(ref)
	req := withURLParam(newRequest(http.MethodGet, "/api/kb/pages/"+escaped+"?"+query, nil), "id", escaped)
	var got KbPageResponse
	rec := testutil.Call(t, testHandler.GetKbPage, req).Want(want)
	if want == http.StatusOK {
		rec.JSON(&got)
	}

	return got
}

func TestGetKbPage(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	slug := fmt.Sprintf("read-%d", time.Now().UnixNano())
	base := insertTestKbBase(t, "Read KB", slug)
	payment := createTestKbPage(t, base, kb.NewPage{Slug: "payment", Title: "支付", Position: "a0", Markdown: "支付"})
	idem := createTestKbPage(t, base, kb.NewPage{ParentID: payment, Slug: "idempotency", Title: "幂等键", Position: "a1", Markdown: "幂等"})
	callback := createTestKbPage(t, base, kb.NewPage{
		ParentID: payment, Slug: "callback", Title: "支付回调", Position: "a0",
		Frontmatter: map[string]any{"type": "Workflow", "title": "支付回调", "tags": []string{"dev"}},
		Markdown:    "## 去重\n\n按渠道交易号去重。[^mar-142]\n\n见[幂等键](/payment/idempotency.md#^b9Lm)。",
	})
	// idempotency links back to the callback page.
	dbfx.Exec(t, `INSERT INTO kb_link (workspace_id, knowledge_base_id, from_page_id, from_block_id, to_page_id, to_path)
		VALUES ($1, $2, $3, 'bAAA', $4, '/payment/callback')`, testWorkspaceID, base, idem, callback)

	var blockID string
	dbfx.QueryRow(t, `SELECT blocks->1->>'id' FROM kb_page WHERE id = $1`, callback).Scan(&blockID)
	evidence := `[{"source":"mar-142","uri":"task://MAR-999999","title":"回调改用渠道交易号去重","version":"v1"},
		{"source":"spec","uri":"raw://sources/channel-v3.pdf#page=12","title":"渠道接入规范 v3"},
		{"source":"talk","uri":"chat://6a3c0a52-6f0e-4bb5-9c62-000000000001","title":"chat"},
		{"source":"site","uri":"https://example.com","title":"官网"}]`
	dbfx.Insert(t, "kb_claim", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "page_id": callback, "block_id": blockID,
		"key": "c1", "text": "按渠道交易号去重。", "evidence": evidence, "checked_at": time.Now(),
	})
	raw := dbfx.Insert(t, "kb_raw", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "kind": kb.RawKindSource, "name": "channel-v3.pdf",
		"storage_key": "k", "size": 10, "content_type": "application/pdf", "uploaded_by": testUserID,
	})
	dbfx.InsertNoID(t, "kb_annotation", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "page_id": callback, "body": "check",
		"author_type": "member", "author_id": testUserID,
	}, "knowledge_base_id = $1", base)

	var currentBlocks string
	dbfx.QueryRow(t, `SELECT blocks::text FROM kb_page WHERE id = $1`, callback).Scan(&currentBlocks)
	mergeTestKbRevision(t, base, callback, 15, "去重", currentBlocks, time.Now().Add(-time.Minute))

	openDraft := insertTestKbDraft(t, base, testUserID, 3)
	insertTestKbDraftPage(t, openDraft, callback, kb.DraftOpUpdate, payment, "a0", "callback", "支付回调（草稿）",
		kbTestBlocks(t, blockID, "按订单号去重。"))
	dbfx.Insert(t, "kb_merge_request", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "number": 16, "title": "去重键改为渠道交易号",
		"source": "custom", "author_type": "member", "author_id": testUserID, "draft_id": openDraft,
	})
	// Another member's open request on the same page.
	someoneElse := "6a3c0a52-6f0e-4bb5-9c62-0d1f2e3a4b5f"
	theirDraft := insertTestKbDraft(t, base, someoneElse, 1)
	insertTestKbDraftPage(t, theirDraft, callback, kb.DraftOpUpdate, payment, "a0", "callback", "支付回调",
		kbTestBlocks(t, blockID, "按退款单号去重。"))
	dbfx.Insert(t, "kb_merge_request", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "number": 18, "title": "退款回调也按渠道交易号去重",
		"source": "custom", "author_type": "member", "author_id": someoneElse, "draft_id": theirDraft,
		"updated_at": time.Now().Add(time.Minute),
	})

	page := getKbPage(t, callback, "", http.StatusOK)
	if page.Path != "/payment/callback" || len(page.Breadcrumb) != 1 || page.Breadcrumb[0].Title != "支付" {
		t.Fatalf("path/breadcrumb = %q %+v", page.Path, page.Breadcrumb)
	}
	if page.Frontmatter["type"] != "Workflow" || page.DraftChange != "" {
		t.Errorf("frontmatter = %+v change=%q", page.Frontmatter, page.DraftChange)
	}
	wantLink := "](/kb/" + slug + "/p/" + idem + "#b9Lm)"
	if len(page.Blocks) != 3 || !strings.Contains(page.Blocks[2].Content, wantLink) {
		t.Errorf("blocks = %+v, want link routed as %s", page.Blocks, wantLink)
	}

	sources := map[string]KbSourceResponse{}
	for _, s := range page.Sources {
		sources[s.ID] = s
	}
	if len(page.Sources) != 4 || page.Sources[0].ID != "mar-142" {
		t.Fatalf("sources = %+v", page.Sources)
	}
	if s := sources["mar-142"]; s.Kind != kb.SourceKindTask || s.Openable || s.Version != "v1" {
		t.Errorf("task source = %+v, want missing issue not openable", s)
	}
	if s := sources["spec"]; !s.Openable || s.Raw == nil || s.Raw.ID != raw || s.Raw.Page != 12 || s.Raw.UploadedBy != testUserID {
		t.Errorf("raw source = %+v (raw %+v)", s, s.Raw)
	}
	if s := sources["talk"]; s.Kind != kb.SourceKindChat || s.Openable {
		t.Errorf("chat source = %+v, want not openable for a chat the caller did not start", s)
	}
	if s := sources["site"]; s.Kind != kb.SourceKindWeb || !s.Openable {
		t.Errorf("web source = %+v", s)
	}
	if len(page.Claims) != 1 || page.Claims[0].BlockID != blockID || page.Claims[0].Text != "按渠道交易号去重。" {
		t.Errorf("claims = %+v", page.Claims)
	}

	if page.LastMR == nil || page.LastMR.Number != 15 || page.LastMR.AuthorName != handlerTestName {
		t.Errorf("last_mr = %+v", page.LastMR)
	}
	if len(page.Backlinks) != 1 || page.Backlinks[0].ID != idem {
		t.Errorf("backlinks = %+v", page.Backlinks)
	}
	if page.PendingMR == nil || page.PendingMR.Number != 18 || page.PendingMRCount != 2 {
		t.Errorf("pending_mr = %+v (%d)", page.PendingMR, page.PendingMRCount)
	}
	if len(page.PendingMRs) != 1 || page.PendingMRs[0].Number != 18 || page.PendingMRs[0].Status != kb.MergeRequestStatusOpen {
		t.Errorf("pending_mrs = %+v, want only the other member's #18", page.PendingMRs)
	}
	if page.AnnotationsOpen != 1 {
		t.Errorf("annotations_open = %d", page.AnnotationsOpen)
	}
	if len(page.Drafts) != 1 || page.Drafts[0].ID != openDraft || page.Drafts[0].ChangedBlocks != 3 ||
		page.Drafts[0].DraftChange != kb.DraftChangeModified {
		t.Errorf("drafts = %+v, want the open draft with 3 changed blocks", page.Drafts)
	} else if mr := page.Drafts[0].MergeRequest; mr == nil || mr.Number != 16 || mr.Title != "去重键改为渠道交易号" {
		t.Errorf("draft merge_request = %+v, want #16", mr)
	}

	byPath := getKbPage(t, slug+":/payment/callback.md", "", http.StatusOK)
	if byPath.ID != callback {
		t.Errorf("by path = %s, want %s", byPath.ID, callback)
	}

	draftView := getKbPage(t, callback, "draft="+openDraft, http.StatusOK)
	if draftView.Version != "d3" || draftView.DraftChange != kb.DraftChangeModified ||
		len(draftView.Blocks) != 1 || draftView.Blocks[0].Content != "按订单号去重。" {
		t.Errorf("draft view = %+v", draftView)
	}
	if draftView.Frontmatter["title"] != "支付回调（草稿）" {
		t.Errorf("draft frontmatter = %+v", draftView.Frontmatter)
	}

	created := "6a3c0a52-6f0e-4bb5-9c62-0d1f2e3a4b5d"
	insertTestKbDraftPage(t, openDraft, created, kb.DraftOpCreate, payment, "a2", "manual", "回调人工处理", kbTestBlocks(t, "bN01", "步骤"))
	newPage := getKbPage(t, created, "draft="+openDraft, http.StatusOK)
	if newPage.Path != "/payment/manual" || newPage.DraftChange != kb.DraftChangeAdded || newPage.LastMR != nil {
		t.Errorf("draft-only page = %+v", newPage)
	}
	getKbPage(t, created, "", http.StatusNotFound)
	getKbPage(t, slug+":/payment/manual", "draft="+openDraft, http.StatusOK)

	// Someone else's draft: the workspace owner may read it, a plain member not.
	otherDraft := insertTestKbDraft(t, base, "6a3c0a52-6f0e-4bb5-9c62-0d1f2e3a4b5e", 1)
	getKbPage(t, callback, "draft="+otherDraft, http.StatusOK)
	plain := createPlainMember(t, fmt.Sprintf("kb-read-plain-%d@marvis.ai", time.Now().UnixNano()))
	plainReq := withURLParam(newRequestAs(plain, http.MethodGet, "/api/kb/pages/x?draft="+otherDraft, nil), "id", callback)
	testutil.Call(t, testHandler.GetKbPage, plainReq).Want(http.StatusForbidden)
	getKbPage(t, "00000000-0000-0000-0000-000000000001", "", http.StatusNotFound)
	getKbPage(t, slug+":/missing", "", http.StatusNotFound)
	getKbPage(t, "/payment", "", http.StatusBadRequest)
}

func TestKbPageHistory(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	slug := fmt.Sprintf("hist-%d", time.Now().UnixNano())
	base := insertTestKbBase(t, "History KB", slug)
	target := createTestKbPage(t, base, kb.NewPage{Slug: "target", Title: "Target", Markdown: "t"})
	page := createTestKbPage(t, base, kb.NewPage{Slug: "flow", Title: "Flow", Position: "a1", Markdown: "## 处理顺序\n\n每 30 分钟补查。"})

	var initial, heading string
	dbfx.QueryRow(t, `SELECT head_revision_id::text, blocks->0->>'id' FROM kb_page WHERE id = $1`, page).Scan(&initial, &heading)
	revision := mergeTestKbRevision(t, base, page, 9, "处理批注：补查间隔",
		kbTestBlocks(t, heading, "## 处理顺序", "bZ01", "每 10 分钟补查，见[目标](kb://"+target+")。"), time.Now())

	req := withURLParam(newRequest(http.MethodGet, "/api/kb/pages/"+page+"/history", nil), "id", page)
	var history []KbRevisionResponse
	testutil.Call(t, testHandler.ListKbPageHistory, req).Want(http.StatusOK).JSON(&history)
	if len(history) != 2 {
		t.Fatalf("history = %+v, want 2 revisions", history)
	}
	latest, first := history[0], history[1]
	if latest.RevisionID != revision || !latest.Current || latest.MRNumber == nil || *latest.MRNumber != 9 ||
		latest.Added != 1 || latest.Deleted != 1 || latest.AuthorName != handlerTestName ||
		latest.MergedByName != handlerTestName || latest.Annotations != 1 {
		t.Errorf("latest = %+v", latest)
	}
	if first.RevisionID != initial || first.Current || first.MRNumber != nil || first.Added != 3 || first.Deleted != 0 {
		t.Errorf("initial = %+v", first)
	}

	diffReq := withURLParams(newRequest(http.MethodGet, "/api/kb/pages/"+page+"/history/"+revision, nil), "id", page, "revisionId", revision)
	var diff KbRevisionDiffResponse
	testutil.Call(t, testHandler.GetKbRevisionDiff, diffReq).Want(http.StatusOK).JSON(&diff)
	if diff.PrevRevisionID != initial || len(diff.Hunks) != 1 || diff.Hunks[0].Heading != "处理顺序" {
		t.Fatalf("diff = %+v", diff)
	}
	var added string
	for _, line := range diff.Hunks[0].Lines {
		if line.Op == kb.DiffAdded {
			added = line.Text
		}
	}
	if added != "每 10 分钟补查，见[目标](/target.md)。" {
		t.Errorf("added line = %q, want kb:// shown as a path", added)
	}

	missing := withURLParams(newRequest(http.MethodGet, "/", nil), "id", page, "revisionId", initial+"x")
	testutil.Call(t, testHandler.GetKbRevisionDiff, missing).Want(http.StatusNotFound)
}

func TestGetKbHome(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	slug := fmt.Sprintf("home-%d", time.Now().UnixNano())
	base := insertTestKbBase(t, "Home KB", slug)
	payment := createTestKbPage(t, base, kb.NewPage{Slug: "payment", Title: "支付", Position: "a0", Markdown: "p"})
	release := createTestKbPage(t, base, kb.NewPage{Slug: "release", Title: "发布", Position: "a1", Markdown: "r"})

	now := time.Now()
	mergeTestKbRevision(t, base, payment, 11, "合并 11", kbTestBlocks(t, "bP01", "p1"), now.Add(-3*time.Hour))
	mergeTestKbRevision(t, base, release, 12, "合并 12", kbTestBlocks(t, "bR01", "r1"), now.Add(-2*time.Hour))
	mergeTestKbRevision(t, base, payment, 13, "合并 13", kbTestBlocks(t, "bP02", "p2"), now.Add(-time.Hour))
	dbfx.Insert(t, "kb_merge_request", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "number": 14, "title": "待审核",
		"source": "custom", "author_type": "member", "author_id": testUserID,
		"draft_id": testutil.Raw("gen_random_uuid()"),
	})
	for _, authorType := range []string{"member", "agent"} {
		dbfx.InsertNoID(t, "kb_annotation", testutil.Cols{
			"workspace_id": testWorkspaceID, "knowledge_base_id": base, "body": "gap",
			"author_type": authorType, "author_id": testUserID,
		}, "knowledge_base_id = $1", base)
	}

	req := withURLParam(newRequest(http.MethodGet, "/api/kb/bases/"+slug+"/home", nil), "kb", slug)
	var home KbHomeResponse
	testutil.Call(t, testHandler.GetKbHome, req).Want(http.StatusOK).JSON(&home)

	if home.KnowledgeBase.ID != base || home.KnowledgeBase.PageCount != 2 {
		t.Errorf("knowledge_base = %+v", home.KnowledgeBase)
	}
	if home.Pending.Annotations != 2 || home.Pending.AgentReported != 1 || home.Pending.OpenMRs != 1 ||
		home.Pending.LatestMR == nil || home.Pending.LatestMR.Number != 14 {
		t.Errorf("pending = %+v", home.Pending)
	}
	if len(home.Recent) != 2 || home.Recent[0].PageID != payment || home.Recent[0].MRNumber != 13 ||
		home.Recent[0].Path != "/payment" || home.Recent[1].PageID != release {
		t.Errorf("recent = %+v, want payment (#13) then release, each once", home.Recent)
	}
	if home.RunningJobs != 0 {
		t.Errorf("running_jobs = %d", home.RunningJobs)
	}

	empty := insertTestKbBase(t, "Empty KB", slug+"-empty")
	req = withURLParam(newRequest(http.MethodGet, "/", nil), "kb", empty)
	var bare KbHomeResponse
	testutil.Call(t, testHandler.GetKbHome, req).Want(http.StatusOK).JSON(&bare)
	if len(bare.Recent) != 0 || bare.Pending.LatestMR != nil {
		t.Errorf("empty home = %+v", bare)
	}
}
