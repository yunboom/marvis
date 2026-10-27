package handler

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/kb/lint"
	"github.com/yunboom/marvis/server/internal/testutil"
)

// kbDraftFixture is a knowledge base with two mainline pages and an open
// draft of the test user.
type kbDraftFixture struct {
	baseID  string
	slug    string
	pageA   string
	pageB   string
	draftID string
	headA   string
}

func newKbDraftFixture(t *testing.T) kbDraftFixture {
	t.Helper()

	slug := fmt.Sprintf("draft-%d", time.Now().UnixNano())
	base := insertTestKbBase(t, "Draft KB", slug)
	pageA := createTestKbPage(t, base, kb.NewPage{
		Slug: "callback", Title: "Callback", Position: "a0",
		Frontmatter: map[string]any{"type": "Workflow", "title": "Callback", "description": "d"},
		Markdown:    "# Callback\n\n## Dedup\n\nBy order id.\n\nSee [b](/b.md).",
	})
	pageB := createTestKbPage(t, base, kb.NewPage{
		Slug: "b", Title: "B", Position: "a1",
		Frontmatter: map[string]any{"type": "Guide", "title": "B", "description": "d"},
		Markdown:    "B body",
	})

	f := kbDraftFixture{baseID: base, slug: slug, pageA: pageA, pageB: pageB}
	f.draftID = createKbDraftAs(t, slug, nil)
	f.headA = kbPageHead(t, pageA)

	return f
}

func kbPageHead(t *testing.T, pageID string) string {
	t.Helper()

	var head string
	dbfx.QueryRow(t, `SELECT head_revision_id FROM kb_page WHERE id = $1`, pageID).Scan(&head)

	return head
}

func createKbDraftAs(t *testing.T, baseRef string, mutate func(*http.Request)) string {
	t.Helper()

	req := newRequest(http.MethodPost, "/api/kb/drafts", map[string]any{"knowledge_base": baseRef, "title": "t"})
	if mutate != nil {
		mutate(req)
	}
	var got KbDraftResponse
	testutil.Call(t, testHandler.CreateKbDraft, req).Want(http.StatusCreated).JSON(&got)

	return got.ID
}

func kbFetch(t *testing.T, ref, query string, want int) map[string]any {
	t.Helper()

	req := testutil.WithURLParams(newRequest(http.MethodGet, "/api/kb/pages/x/fetch?"+query, nil), "id", url.PathEscape(ref))
	rec := testutil.Call(t, testHandler.FetchKbPage, req).Want(want)

	return rec.Map()
}

func kbOps(t *testing.T, draftID, ref, version string, want int, ops ...map[string]any) map[string]any {
	t.Helper()

	req := testutil.WithURLParams(newRequest(http.MethodPost, "/api/kb/drafts/x/pages/x/ops", map[string]any{"version": version, "ops": ops}),
		"draftId", draftID, "id", url.PathEscape(ref))
	rec := testutil.Call(t, testHandler.ApplyKbPageOps, req).Want(want)

	return rec.Map()
}

func kbDraftDetail(t *testing.T, draftID string) KbDraftDetailResponse {
	t.Helper()

	var got KbDraftDetailResponse
	req := testutil.WithURLParams(newRequest(http.MethodGet, "/api/kb/drafts/x", nil), "draftId", draftID)
	testutil.Call(t, testHandler.GetKbDraft, req).Want(http.StatusOK).JSON(&got)

	return got
}

func blockIDsOf(t *testing.T, fetched map[string]any) []string {
	t.Helper()

	raw, _ := fetched["blocks"].([]any)
	ids := make([]string, len(raw))
	for i, b := range raw {
		ids[i] = b.(map[string]any)["id"].(string)
	}

	return ids
}

func TestCreateKbDraftRecordsTask(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbDraftFixture(t)
	var taskID *string
	dbfx.QueryRow(t, `SELECT task_id::text FROM kb_draft WHERE id = $1`, f.draftID).Scan(&taskID)
	if taskID != nil {
		t.Errorf("member draft task_id = %v, want NULL", *taskID)
	}

	agentID := dbfx.Agent(t, fmt.Sprintf("kb-draft-agent-%d", time.Now().UnixNano()), testRuntimeID)
	task := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": testRuntimeID})
	draftID := createKbDraftAs(t, f.baseID, func(r *http.Request) {
		r.Header.Set("X-Actor-Source", "task_token")
		r.Header.Set("X-Agent-ID", agentID)
		r.Header.Set("X-Task-ID", task)
	})
	var recorded string
	dbfx.QueryRow(t, `SELECT task_id::text FROM kb_draft WHERE id = $1`, draftID).Scan(&recorded)
	if recorded != task {
		t.Errorf("task draft task_id = %s, want %s", recorded, task)
	}

	req := newRequest(http.MethodPost, "/api/kb/drafts", map[string]any{"knowledge_base": f.slug})
	if body := testutil.Call(t, testHandler.CreateKbDraft, req).Want(http.StatusCreated).Text(); strings.Contains(body, "task_id") {
		t.Errorf("response exposes task_id: %s", body)
	}
}

func TestCreateKbDraftLinksJob(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbDraftFixture(t)
	agentID := dbfx.Agent(t, fmt.Sprintf("kb-job-agent-%d", time.Now().UnixNano()), testRuntimeID)
	session := dbfx.ChatSession(t, agentID)
	insertJob := func(baseID, createdBy, chatSession string) string {
		return dbfx.Insert(t, "kb_job", testutil.Cols{
			"workspace_id": testWorkspaceID, "knowledge_base_id": baseID, "name": "Job", "starter": "custom",
			"agent_id": agentID, "chat_session_id": chatSession, "created_by": createdBy,
		})
	}
	job := insertJob(f.baseID, testUserID, session)
	dbfx.Cleanup(t, `DELETE FROM kb_job_draft WHERE job_id = $1`, job)

	create := func(jobID string, mutate func(*http.Request), want int) map[string]any {
		req := newRequest(http.MethodPost, "/api/kb/drafts", map[string]any{"knowledge_base": f.slug, "job_id": jobID})
		if mutate != nil {
			mutate(req)
		}

		return testutil.Call(t, testHandler.CreateKbDraft, req).Want(want).Map()
	}

	linked := create(job, nil, http.StatusCreated)
	var draftOfJob string
	dbfx.QueryRow(t, `SELECT draft_id::text FROM kb_job_draft WHERE job_id = $1`, job).Scan(&draftOfJob)
	if draftOfJob != linked["id"] {
		t.Fatalf("kb_job_draft draft = %s, want %v", draftOfJob, linked["id"])
	}

	dup := create(job, nil, http.StatusConflict)
	if dup["code"] != kbCodeJobDraftExists || dup["draft_id"] != draftOfJob {
		t.Errorf("second link = %v, want job_draft_exists with draft_id", dup)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM kb_draft WHERE knowledge_base_id = $1`, f.baseID); n != 2 {
		t.Errorf("drafts = %d, want the rejected draft rolled back", n)
	}

	other := insertTestKbBase(t, "Other KB", f.slug+"-o")
	foreign := insertJob(other, testUserID, dbfx.ChatSession(t, agentID))
	if got := create(foreign, nil, http.StatusNotFound); got["code"] != kbCodeJobNotFound {
		t.Errorf("job of another knowledge base = %v", got)
	}

	member := createPlainMember(t, fmt.Sprintf("kb-job-%d@marvis.ai", time.Now().UnixNano()))
	notMine := insertJob(f.baseID, member, dbfx.ChatSession(t, agentID))
	dbfx.Cleanup(t, `DELETE FROM kb_job_draft WHERE job_id = $1`, notMine)
	if got := create(notMine, nil, http.StatusForbidden); got["code"] != kbCodeForbidden {
		t.Errorf("job of another member = %v", got)
	}

	jobSession := dbfx.ChatSession(t, agentID)
	agentJob := insertJob(f.baseID, member, jobSession)
	dbfx.Cleanup(t, `DELETE FROM kb_job_draft WHERE job_id = $1`, agentJob)
	task := dbfx.Task(t, agentID, testutil.Cols{"chat_session_id": jobSession, "runtime_id": testRuntimeID})
	create(agentJob, func(r *http.Request) {
		r.Header.Set("X-Actor-Source", "task_token")
		r.Header.Set("X-Agent-ID", agentID)
		r.Header.Set("X-Task-ID", task)
	}, http.StatusCreated)
}

func TestFetchKbPageScopes(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbDraftFixture(t)
	ref := f.slug + ":/callback"

	full := kbFetch(t, ref, "", http.StatusOK)
	if full["version"] != f.headA || full["blocks"] != nil || full["mention"] != "[Callback](mention://kb_page/"+f.pageA+")" {
		t.Fatalf("full fetch = %v", full)
	}
	content, _ := full["content"].(string)
	if !strings.Contains(content, "[b](/b.md)") {
		t.Errorf("kb:// links not shown as paths: %q", content)
	}

	outline := kbFetch(t, f.pageA, "scope=outline&detail=with-ids", http.StatusOK)
	ids := blockIDsOf(t, outline)
	if len(ids) != 2 {
		t.Fatalf("outline = %v", outline["blocks"])
	}

	section := kbFetch(t, ref, "scope=section&detail=with-ids&start_block_id="+ids[1], http.StatusOK)
	if got := blockIDsOf(t, section); len(got) != 3 || got[0] != ids[1] {
		t.Errorf("section = %v", got)
	}
	kbFetch(t, ref, "scope=section&start_block_id=bZZZ", http.StatusNotFound)
	kbFetch(t, ref, "scope=range", http.StatusBadRequest)
	kbFetch(t, ref, "revision_id="+f.headA+"&draft="+f.draftID, http.StatusBadRequest)

	rev := kbFetch(t, ref, "revision_id="+f.headA, http.StatusOK)
	if rev["version"] != f.headA {
		t.Errorf("revision fetch version = %v", rev["version"])
	}

	draft := kbFetch(t, ref, "draft="+f.draftID, http.StatusOK)
	if draft["version"] != f.headA {
		t.Errorf("untouched page in a draft reports %v, want the mainline revision", draft["version"])
	}
}

func TestKbPageOpsWritesDraft(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbDraftFixture(t)
	ref := f.slug + ":/callback"
	ids := blockIDsOf(t, kbFetch(t, ref, "detail=with-ids&draft="+f.draftID, http.StatusOK))
	dedup, body := ids[2], ids[3]

	first := kbOps(t, f.draftID, ref, f.headA, http.StatusOK,
		map[string]any{"op": kb.OpBlockReplace, "block": dedup, "content": "By trade no.\n\nAnd a key."},
		map[string]any{"op": kb.OpBlockInsertAfter, "block": kb.BlockStart, "content": "Intro."},
		map[string]any{"op": kb.OpBlockDelete, "block": body},
		map[string]any{"op": kb.OpSetMeta, "fields": map[string]any{"status": "stable", "stale_after": "2027-01-20"}},
	)
	if first["version"] != "d1" || len(first["new_blocks"].([]any)) != 2 {
		t.Fatalf("first write = %v", first)
	}

	kbOps(t, f.draftID, ref, f.headA, http.StatusConflict, map[string]any{"op": kb.OpAppend, "content": "x"})
	stale := kbOps(t, f.draftID, ref, "d0", http.StatusConflict, map[string]any{"op": kb.OpAppend, "content": "x"})
	if stale["code"] != kbCodeStaleVersion {
		t.Errorf("stale write = %v", stale)
	}

	// Writing another page bumps the draft version but leaves this page's
	// version valid.
	kbOps(t, f.draftID, f.slug+":/b", kbPageHead(t, f.pageB), http.StatusOK, map[string]any{"op": kb.OpAppend, "content": "more"})
	kbOps(t, f.draftID, ref, "d1", http.StatusOK, map[string]any{"op": kb.OpStrReplace, "find": "trade no", "replace": "channel trade no"})

	if got := kbOps(t, f.draftID, ref, "d3", http.StatusConflict, map[string]any{"op": kb.OpStrReplace, "find": "zzz", "replace": "y"}); got["code"] != kbCodeStrReplaceMatch {
		t.Errorf("str_replace without a match = %v", got)
	}
	if got := kbOps(t, f.draftID, ref, "d3", http.StatusConflict, map[string]any{"op": kb.OpAppend, "content": "<<<<<<< 主线\na\n=======\nb\n>>>>>>> 草稿"}); got["code"] != kbCodeConflictMarkers {
		t.Errorf("write with conflict markers = %v", got)
	}
	if got := kbOps(t, f.draftID, ref, "d3", http.StatusNotFound, map[string]any{"op": kb.OpBlockDelete, "block": "bZZZ"}); got["code"] != kbCodeBlockNotFound {
		t.Errorf("missing block = %v", got)
	}
	kbOps(t, f.draftID, ref, "d3", http.StatusBadRequest, map[string]any{"op": kb.OpSetMeta, "fields": map[string]any{"sources": []any{}}})

	draft := kbFetch(t, ref, "draft="+f.draftID, http.StatusOK)
	content, _ := draft["content"].(string)
	if draft["version"] != "d3" || !strings.HasPrefix(content, "Intro.") || !strings.Contains(content, "By channel trade no.") || strings.Contains(content, "See [b]") {
		t.Errorf("draft copy = %v", draft)
	}
	if fm := draft["frontmatter"].(map[string]any); fm["status"] != "stable" || fm["stale_after"] != "2027-01-20T00:00:00Z" {
		t.Errorf("draft header = %v", fm)
	}

	main := kbFetch(t, ref, "", http.StatusOK)
	if c, _ := main["content"].(string); !strings.Contains(c, "By order id.") {
		t.Errorf("mainline changed: %q", c)
	}

	detail := kbDraftDetail(t, f.draftID)
	if len(detail.Pages) != 2 || detail.Version != 3 {
		t.Fatalf("draft detail = %+v", detail)
	}
	for _, p := range detail.Pages {
		if p.Change != kb.DraftChangeModified || p.Added == 0 {
			t.Errorf("page change = %+v", p)
		}
	}
}

func TestKbPageOpsConcurrentWritesOneWins(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbDraftFixture(t)
	ref := f.slug + ":/callback"

	const writers = 4
	statuses := make(chan int, writers)
	var wg sync.WaitGroup
	for i := range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := testutil.WithURLParams(newRequest(http.MethodPost, "/api/kb/drafts/x/pages/x/ops", map[string]any{
				"version": f.headA,
				"ops":     []map[string]any{{"op": kb.OpAppend, "content": fmt.Sprintf("writer %d", i)}},
			}), "draftId", f.draftID, "id", url.PathEscape(ref))
			statuses <- testutil.Call(t, testHandler.ApplyKbPageOps, req).Code
		}()
	}
	wg.Wait()
	close(statuses)

	counts := map[int]int{}
	for s := range statuses {
		counts[s]++
	}
	if counts[http.StatusOK] != 1 || counts[http.StatusConflict] != writers-1 {
		t.Errorf("statuses = %v, want one 200 and the rest 409", counts)
	}
}

func TestKbDraftPagesCreateMoveDelete(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbDraftFixture(t)
	create := func(body map[string]any, want int) map[string]any {
		req := testutil.WithURLParams(newRequest(http.MethodPost, "/api/kb/drafts/x/pages", body), "draftId", f.draftID)

		return testutil.Call(t, testHandler.CreateKbDraftPage, req).Want(want).Map()
	}
	header := map[string]any{"type": "Runbook", "title": "Manual", "description": "How to retry"}

	created := create(map[string]any{
		"parent": f.slug + ":/callback", "slug": "manual", "frontmatter": header,
		"content": "# Manual\n\nSee [cb](/callback.md) and [todo](/todo.md).",
	}, http.StatusCreated)
	pageID := created["page_id"].(string)
	if created["path"] != "/callback/manual" || len(created["blocks"].([]any)) != 2 {
		t.Fatalf("created = %v", created)
	}
	warnCodes := map[string]bool{}
	for _, w := range created["warnings"].([]any) {
		warnCodes[w.(map[string]any)["code"].(string)] = true
	}
	if !warnCodes[lint.CodeUnresolvedLink] || !warnCodes[lint.CodeOrphanPage] {
		t.Errorf("warnings = %v", created["warnings"])
	}

	if got := create(map[string]any{"parent": f.slug + ":/callback", "slug": "manual", "frontmatter": header, "content": "x"}, http.StatusConflict); got["code"] != kbCodeDuplicateSlug {
		t.Errorf("duplicate slug = %v", got)
	}
	create(map[string]any{"parent": f.slug + ":/", "slug": "x", "frontmatter": map[string]any{"type": "Guide"}, "content": "x"}, http.StatusBadRequest)

	byPath := kbFetch(t, f.slug+":/callback/manual", "draft="+f.draftID, http.StatusOK)
	if byPath["page_id"] != pageID {
		t.Errorf("draft page by path = %v", byPath)
	}
	kbFetch(t, f.slug+":/callback/manual", "", http.StatusNotFound)

	kbOps(t, f.draftID, f.pageA, f.headA, http.StatusBadRequest, map[string]any{"op": kb.OpMove, "parent": f.slug + ":/callback/manual"})
	kbOps(t, f.draftID, f.pageA, f.headA, http.StatusConflict, map[string]any{"op": kb.OpDelete})

	moved := kbOps(t, f.draftID, pageID, created["version"].(string), http.StatusOK,
		map[string]any{"op": kb.OpMove, "parent": f.slug + ":/", "after": f.slug + ":/callback", "slug": "manual-retry"})
	if moved["path"] != "/manual-retry" {
		t.Fatalf("moved = %v", moved)
	}
	level := listKbLevel(t, f.slug, "draft="+f.draftID, http.StatusOK)
	if kbLevelTitles(level) != "Callback,Manual(added),B" {
		t.Errorf("top level = %s", kbLevelTitles(level))
	}

	kbOps(t, f.draftID, f.pageB, kbPageHead(t, f.pageB), http.StatusOK, map[string]any{"op": kb.OpDelete})
	kbOps(t, f.draftID, pageID, moved["version"].(string), http.StatusOK, map[string]any{"op": kb.OpDelete})

	detail := kbDraftDetail(t, f.draftID)
	if len(detail.Pages) != 1 || detail.Pages[0].PageID != f.pageB || detail.Pages[0].Change != kb.DraftChangeDeleted {
		t.Errorf("draft pages = %+v", detail.Pages)
	}
}

func TestKbDraftClaims(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbDraftFixture(t)
	ref := f.slug + ":/callback"
	ids := blockIDsOf(t, kbFetch(t, ref, "detail=with-ids", http.StatusOK))
	written := kbOps(t, f.draftID, ref, f.headA, http.StatusOK, map[string]any{"op": kb.OpBlockReplace, "block": ids[2], "content": "By trade no.[^mar-142] Also[^x]"})

	put := func(version string, claims []map[string]any, want int) map[string]any {
		req := testutil.WithURLParams(newRequest(http.MethodPut, "/api/kb/drafts/x/pages/x/claims", map[string]any{"version": version, "claims": claims}),
			"draftId", f.draftID, "id", url.PathEscape(ref))

		return testutil.Call(t, testHandler.PutKbDraftClaims, req).Want(want).Map()
	}
	claim := map[string]any{"key": "c1", "block_id": ids[2], "text": "By trade no.", "checked_at": "2026-10-25T10:28:00Z",
		"evidence": []map[string]any{{"source": "mar-142", "uri": "task://MAR-142", "title": "Dedup", "version": "2026-10-20T08:00:00Z"}}}

	put(written["version"].(string), []map[string]any{claim, claim}, http.StatusBadRequest)
	got := put(written["version"].(string), []map[string]any{claim}, http.StatusOK)
	sources := got["sources"].([]any)
	if len(sources) != 1 || sources[0].(map[string]any)["resource"] != "task://MAR-142" {
		t.Fatalf("sources = %v", got)
	}
	undefined := 0
	for _, w := range got["warnings"].([]any) {
		if w.(map[string]any)["code"] == lint.CodeUndefinedFootnote {
			undefined++
		}
	}
	if undefined != 1 {
		t.Errorf("undefined footnotes = %d, want only [^x]: %v", undefined, got["warnings"])
	}

	fetched := kbFetch(t, ref, "draft="+f.draftID, http.StatusOK)
	if fm := fetched["frontmatter"].(map[string]any); fm["sources"] == nil {
		t.Errorf("draft header has no sources: %v", fm)
	}

	req := testutil.WithURLParams(newRequest(http.MethodGet, "/api/kb/pages/x/claims?draft="+f.draftID, nil), "id", url.PathEscape(ref))
	var claims KbPageClaimsResponse
	testutil.Call(t, testHandler.GetKbPageClaims, req).Want(http.StatusOK).JSON(&claims)
	if len(claims.Claims) != 1 || claims.Claims[0].Evidence[0].Source != "mar-142" {
		t.Errorf("claims get = %+v", claims)
	}
}

func TestKbDraftSyncConflicts(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbDraftFixture(t)
	ref := f.slug + ":/callback"
	ids := blockIDsOf(t, kbFetch(t, ref, "detail=with-ids", http.StatusOK))
	title, heading, dedup, link := ids[0], ids[1], ids[2], ids[3]

	kbOps(t, f.draftID, ref, f.headA, http.StatusOK,
		map[string]any{"op": kb.OpBlockReplace, "block": dedup, "content": "By trade no and key."},
		map[string]any{"op": kb.OpBlockReplace, "block": heading, "content": "## Dedup (draft)"},
	)

	sync := func(want int) KbSyncResponse {
		var got KbSyncResponse
		req := testutil.WithURLParams(newRequest(http.MethodPost, "/api/kb/drafts/x/sync", nil), "draftId", f.draftID)
		rec := testutil.Call(t, testHandler.SyncKbDraft, req).Want(want)
		if want == http.StatusOK {
			rec.JSON(&got)
		}

		return got
	}

	if got := sync(http.StatusOK); len(got.Pages) != 0 || got.Unresolved != 0 || got.Version != 1 {
		t.Fatalf("sync without mainline changes = %+v", got)
	}

	var linkContent string
	dbfx.QueryRow(t, `SELECT b->>'content' FROM kb_page, jsonb_array_elements(blocks) b WHERE id = $1 AND b->>'id' = $2`, f.pageA, link).Scan(&linkContent)
	mainBlocks := kbTestBlocks(t, title, "# Callback main", heading, "## Dedup", dedup, "By trade no and channel.", link, linkContent)
	head := mergeTestKbRevision(t, f.baseID, f.pageA, 1, "main change", mainBlocks, time.Now())

	got := sync(http.StatusOK)
	if got.Unresolved != 1 || len(got.Pages) != 1 || got.Pages[0].Result != kbSyncConflict || got.Pages[0].Conflicts[0].BlockID != dedup {
		t.Fatalf("sync = %+v", got)
	}

	fetched := kbFetch(t, ref, "detail=with-ids&draft="+f.draftID, http.StatusOK)
	blocks := map[string]string{}
	for _, b := range fetched["blocks"].([]any) {
		m := b.(map[string]any)
		blocks[m["id"].(string)] = m["content"].(string)
	}
	if blocks[title] != "# Callback main" || blocks[heading] != "## Dedup (draft)" ||
		blocks[dedup] != kb.ConflictContent("By trade no and channel.", "By trade no and key.") {
		t.Errorf("merged blocks = %v", blocks)
	}
	var base string
	dbfx.QueryRow(t, `SELECT base_revision_id::text FROM kb_draft_page WHERE draft_id = $1 AND page_id = $2`, f.draftID, f.pageA).Scan(&base)
	if base != head {
		t.Errorf("base_revision_id = %s, want the mainline head %s", base, head)
	}

	detail := kbDraftDetail(t, f.draftID)
	if len(detail.Checks.Conflicts) != 1 || detail.Checks.Conflicts[0].MainLines == "" {
		t.Errorf("check conflicts = %+v", detail.Checks.Conflicts)
	}
	if !kbHasFinding(detail.Checks.Lint, lint.CodeUnresolvedConflict) {
		t.Errorf("check lint = %+v, want unresolved_conflict", detail.Checks.Lint)
	}

	version := fetched["version"].(string)
	kbOps(t, f.draftID, ref, version, http.StatusConflict, map[string]any{"op": kb.OpBlockReplace, "block": dedup, "content": blocks[dedup]})
	kbOps(t, f.draftID, ref, version, http.StatusOK, map[string]any{"op": kb.OpBlockReplace, "block": dedup, "content": "By trade no, channel and key."})

	detail = kbDraftDetail(t, f.draftID)
	if len(detail.Checks.Conflicts) != 0 || kbHasFinding(detail.Checks.Lint, lint.CodeUnresolvedConflict) {
		t.Errorf("after resolving = %+v", detail.Checks)
	}

	dbfx.Exec(t, `UPDATE kb_draft SET status = $2 WHERE id = $1`, f.draftID, kb.DraftStatusMerged)
	sync(http.StatusConflict)
}

func kbHasFinding(findings []lint.Finding, code string) bool {
	for _, f := range findings {
		if f.Code == code {
			return true
		}
	}

	return false
}

func TestKbDraftOnlyCreatorWrites(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbDraftFixture(t)
	member := createPlainMember(t, fmt.Sprintf("kb-draft-%d@marvis.ai", time.Now().UnixNano()))
	req := testutil.WithURLParams(newRequestAs(member, http.MethodGet, "/api/kb/drafts/x", nil), "draftId", f.draftID)
	testutil.Call(t, testHandler.GetKbDraft, req).Want(http.StatusForbidden)
}

// TestKbDraftReaders: besides its creator, a draft is read by whoever may
// merge into the knowledge base (an owner or admin, the knowledge base
// creator); other members get 403. The page's draft banner still lists the
// reader's own drafts only.
func TestKbDraftReaders(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbDraftFixture(t)
	blocks := blockIDsOf(t, kbFetch(t, f.pageA, "detail=with-ids", http.StatusOK))
	kbOps(t, f.draftID, f.pageA, f.headA, http.StatusOK, map[string]any{"op": kb.OpBlockReplace, "block": blocks[2], "content": "By trade no."})

	readDraft := func(userID string, want int) {
		t.Helper()
		req := testutil.WithURLParams(newRequestAs(userID, http.MethodGet, "/api/kb/drafts/x", nil), "draftId", f.draftID)
		testutil.Call(t, testHandler.GetKbDraft, req).Want(want)
	}
	readPage := func(userID, query string, want int) KbPageResponse {
		t.Helper()
		req := withURLParam(newRequestAs(userID, http.MethodGet, "/api/kb/pages/x?"+query, nil), "id", f.pageA)
		var got KbPageResponse
		rec := testutil.Call(t, testHandler.GetKbPage, req).Want(want)
		if want == http.StatusOK {
			rec.JSON(&got)
		}
		return got
	}

	plain := createPlainMember(t, fmt.Sprintf("kb-draft-plain-%d@marvis.ai", time.Now().UnixNano()))
	readDraft(plain, http.StatusForbidden)
	readPage(plain, "draft="+f.draftID, http.StatusForbidden)

	admin := createPlainMember(t, fmt.Sprintf("kb-draft-admin-%d@marvis.ai", time.Now().UnixNano()))
	dbfx.Exec(t, `UPDATE member SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2`, testWorkspaceID, admin)
	readDraft(admin, http.StatusOK)
	readPage(admin, "draft="+f.draftID, http.StatusOK)
	if got := readPage(admin, "", http.StatusOK); len(got.Drafts) != 0 {
		t.Errorf("admin's draft banner lists someone else's draft: %+v", got.Drafts)
	}
	if got := readPage(testUserID, "", http.StatusOK); len(got.Drafts) != 1 {
		t.Errorf("creator's draft banner = %+v", got.Drafts)
	}

	creator := createPlainMember(t, fmt.Sprintf("kb-draft-creator-%d@marvis.ai", time.Now().UnixNano()))
	dbfx.Exec(t, `UPDATE kb_base SET created_by = $2 WHERE id = $1`, f.baseID, creator)
	readDraft(creator, http.StatusOK)
}

func TestListKbPagesTypeFilterAndTotal(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbDraftFixture(t)
	createTestKbPage(t, f.baseID, kb.NewPage{Slug: "r1", Title: "R1", Type: "Runbook", Position: "a2", Markdown: "x"})
	createTestKbPage(t, f.baseID, kb.NewPage{Slug: "r2", Title: "R2", Type: "Runbook", Position: "a3", Markdown: "x"})
	createTestKbPage(t, f.baseID, kb.NewPage{ParentID: f.pageA, Slug: "c1", Title: "C1", Type: "Runbook", Position: "a0", Markdown: "x"})
	createTestKbPage(t, f.baseID, kb.NewPage{ParentID: f.pageA, Slug: "c2", Title: "C2", Type: "Guide", Position: "a1", Markdown: "x"})

	all := listKbLevel(t, f.slug, "", http.StatusOK)
	if all.Total != 4 || len(all.Pages) != 4 {
		t.Errorf("top level total = %d pages = %s", all.Total, kbLevelTitles(all))
	}

	first := listKbLevel(t, f.slug, "type=runbook&limit=1", http.StatusOK)
	if kbLevelTitles(first) != "R1" || first.Total != 2 || first.NextCursor == "" {
		t.Fatalf("first runbook page = %s total=%d next=%q", kbLevelTitles(first), first.Total, first.NextCursor)
	}
	second := listKbLevel(t, f.slug, "type=runbook&limit=1&cursor="+url.QueryEscape(first.NextCursor), http.StatusOK)
	if kbLevelTitles(second) != "R2" || second.Total != 2 || second.NextCursor != "" {
		t.Errorf("second runbook page = %s total=%d next=%q", kbLevelTitles(second), second.Total, second.NextCursor)
	}

	children := listKbLevel(t, f.slug, "type=Runbook&parent="+url.QueryEscape(f.slug+":/callback"), http.StatusOK)
	if kbLevelTitles(children) != "C1" || children.Total != 1 {
		t.Errorf("runbooks under callback = %s total=%d", kbLevelTitles(children), children.Total)
	}

	req := testutil.WithURLParams(newRequest(http.MethodPost, "/api/kb/drafts/x/pages", map[string]any{
		"parent": f.slug + ":/", "slug": "r3", "content": "x",
		"frontmatter": map[string]any{"type": "Runbook", "title": "R3", "description": "d"},
	}), "draftId", f.draftID)
	testutil.Call(t, testHandler.CreateKbDraftPage, req).Want(http.StatusCreated)
	withDraft := listKbLevel(t, f.slug, "type=runbook&draft="+f.draftID, http.StatusOK)
	if withDraft.Total != 3 || kbLevelTitles(withDraft) != "R1,R2,R3(added)" {
		t.Errorf("runbooks with draft = %s total=%d", kbLevelTitles(withDraft), withDraft.Total)
	}
	if levelAll := listKbLevel(t, f.slug, "draft="+f.draftID, http.StatusOK); levelAll.Total != 5 {
		t.Errorf("top level with draft total = %d", levelAll.Total)
	}
}

func TestKbSearchStaleAndClaims(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbDraftFixture(t)
	overdue := time.Now().Add(-time.Hour)
	stalePage := createTestKbPage(t, f.baseID, kb.NewPage{Slug: "old", Title: "Old Runbook", Type: "Runbook", Position: "a2", Markdown: "Restart the 去重 worker.", StaleAfter: &overdue})
	dbfx.InsertNoID(t, "kb_claim", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": f.baseID, "page_id": stalePage, "block_id": "b000", "key": "c1",
		"text": "Restart", "evidence": `[{"source":"r","uri":"repo://pay/a.go#L1-L2","title":"a","version":"abc"}]`, "checked_at": time.Now().Add(-48 * time.Hour),
	}, "page_id = $1", stalePage)

	var search KbSearchResponse
	req := newRequest(http.MethodGet, "/api/kb/search?q="+url.QueryEscape("去重 worker")+"&kb="+f.slug, nil)
	testutil.Call(t, testHandler.SearchKb, req).Want(http.StatusOK).JSON(&search)
	if search.Mode != kb.SearchModeKeyword || len(search.Hits) != 1 || search.Hits[0].PageID != stalePage || search.Hits[0].Path != "/old" || search.Hits[0].Mention == "" || search.Hits[0].Excerpt == "" || search.Total != 1 {
		t.Errorf("search = %+v", search)
	}
	req = newRequest(http.MethodGet, "/api/kb/search?q=worker&type=guide&kb="+f.slug, nil)
	testutil.Call(t, testHandler.SearchKb, req).Want(http.StatusOK).JSON(&search)
	if len(search.Hits) != 0 {
		t.Errorf("type filter = %+v", search.Hits)
	}

	var stale []KbStalePage
	req = withURLParam(newRequest(http.MethodGet, "/api/kb/bases/x/stale", nil), "kb", f.slug)
	testutil.Call(t, testHandler.ListKbStalePages, req).Want(http.StatusOK).JSON(&stale)
	if len(stale) != 1 || stale[0].PageID != stalePage || stale[0].Claims != 1 {
		t.Errorf("stale = %+v", stale)
	}

	var claims []KbClaimListItem
	req = withURLParam(newRequest(http.MethodGet, "/api/kb/bases/x/claims?evidence=repo://pay/&checked_before="+url.QueryEscape(time.Now().Format(time.RFC3339)), nil), "kb", f.slug)
	testutil.Call(t, testHandler.ListKbClaims, req).Want(http.StatusOK).JSON(&claims)
	if len(claims) != 1 || claims[0].Path != "/old" || claims[0].Evidence[0].Version != "abc" {
		t.Errorf("claims = %+v", claims)
	}
	req = withURLParam(newRequest(http.MethodGet, "/api/kb/bases/x/claims?evidence=task://", nil), "kb", f.slug)
	testutil.Call(t, testHandler.ListKbClaims, req).Want(http.StatusOK).JSON(&claims)
	if len(claims) != 0 {
		t.Errorf("claims by task prefix = %+v", claims)
	}
}
