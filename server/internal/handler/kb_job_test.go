package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/yunboom/marvis/server/internal/events"
	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/testutil"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// kbJobFixture is a knowledge base with one page, a pending annotation on a
// sentence of it, and an agent the test user may run.
type kbJobFixture struct {
	baseID, slug string
	pageID       string
	annotationID string
	agentID      string
}

func newKbJobFixture(t *testing.T) kbJobFixture {
	t.Helper()

	slug := fmt.Sprintf("job-%d", time.Now().UnixNano())
	base := insertTestKbBase(t, "Job KB", slug)
	page := createTestKbPage(t, base, kb.NewPage{
		Slug: "callback", Title: "Callback", Position: "a0",
		Frontmatter: map[string]any{"type": "Workflow", "title": "Callback", "description": "d"},
		Markdown:    "# Callback\n\nDedup by order id.",
	})
	blocks := blockIDsOf(t, kbFetch(t, page, "detail=with-ids", http.StatusOK))
	annotation := dbfx.Insert(t, "kb_annotation", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "page_id": page,
		"block_id": blocks[1], "quote": "Dedup by order id.", "body": "It is the channel transaction id now.",
		"author_type": kbActorMember, "author_id": testUserID,
	})
	agent := createHandlerTestAgent(t, fmt.Sprintf("kb-job-agent-%d", time.Now().UnixNano()), nil)
	dbfx.Cleanup(t, `DELETE FROM kb_job WHERE knowledge_base_id = $1`, base)
	dbfx.Cleanup(t, `DELETE FROM kb_merge_request WHERE knowledge_base_id = $1`, base)
	dbfx.Cleanup(t, `DELETE FROM kb_job_draft WHERE job_id IN (SELECT id FROM kb_job WHERE knowledge_base_id = $1)`, base)
	dbfx.Cleanup(t, `DELETE FROM chat_session WHERE id IN (SELECT chat_session_id FROM kb_job WHERE knowledge_base_id = $1)`, base)

	return kbJobFixture{baseID: base, slug: slug, pageID: page, annotationID: annotation, agentID: agent}
}

func createKbJob(t *testing.T, slug string, body map[string]any, want int) map[string]any {
	t.Helper()

	req := testutil.WithURLParams(newRequest(http.MethodPost, "/api/kb/bases/x/jobs", body), "kb", slug)

	return testutil.Call(t, testHandler.CreateKbJob, req).Want(want).Map()
}

func getKbJob(t *testing.T, jobID string, mutate func(*http.Request), want int) KbJobDetailResponse {
	t.Helper()

	req := testutil.WithURLParams(newRequest(http.MethodGet, "/api/kb/jobs/x", nil), "jobId", jobID)
	if mutate != nil {
		mutate(req)
	}
	var got KbJobDetailResponse
	rec := testutil.Call(t, testHandler.GetKbJob, req).Want(want)
	if want == http.StatusOK {
		rec.JSON(&got)
	}

	return got
}

func postKbJobAction(t *testing.T, handler http.HandlerFunc, jobID string, body any, want int) map[string]any {
	t.Helper()

	req := testutil.WithURLParams(newRequest(http.MethodPost, "/api/kb/jobs/x/action", body), "jobId", jobID)

	return testutil.Call(t, handler, req).Want(want).Map()
}

// asJobAgent makes a request look like it comes from the job's agent through
// a task token bound to runtimeOwner.
func asJobAgent(runtimeOwner, agentID, taskID string) func(*http.Request) {
	return func(r *http.Request) {
		r.Header.Set("X-User-ID", runtimeOwner)
		r.Header.Set("X-Actor-Source", "task_token")
		r.Header.Set("X-Agent-ID", agentID)
		r.Header.Set("X-Task-ID", taskID)
	}
}

// createKbJobDraft creates a draft as the agent running in the job's chat,
// which links it to the job.
func createKbJobDraft(t *testing.T, f kbJobFixture, jobID string) string {
	t.Helper()

	var taskID string
	dbfx.QueryRow(t, `SELECT t.id FROM agent_task_queue t JOIN kb_job j ON j.chat_session_id = t.chat_session_id WHERE j.id = $1 ORDER BY t.created_at LIMIT 1`, jobID).Scan(&taskID)

	return createKbDraftAs(t, f.slug, asJobAgent(testUserID, f.agentID, taskID))
}

// kbEventRecorder collects one event type for the given knowledge base.
type kbEventRecorder struct {
	mu     sync.Mutex
	events []map[string]any
}

func recordKbEvents(eventType, baseID string) *kbEventRecorder {
	rec := &kbEventRecorder{}
	testHandler.Bus.Subscribe(eventType, func(e events.Event) {
		payload, _ := e.Payload.(map[string]any)
		if payload["knowledge_base_id"] != baseID {
			return
		}
		rec.mu.Lock()
		rec.events = append(rec.events, payload)
		rec.mu.Unlock()
	})

	return rec
}

func (r *kbEventRecorder) all() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()

	return slices.Clone(r.events)
}

// TestKbJobFlow runs a job end to end through the API: start it, the agent
// links a draft and writes into it, the member reads the draft and submits
// it, and the merge request takes over the annotation the job brought in.
func TestKbJobFlow(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	previous := testHandler.kbDraftEvents
	testHandler.kbDraftEvents = &kbDraftNotifier{window: 20 * time.Millisecond}
	t.Cleanup(func() { testHandler.kbDraftEvents = previous })

	f := newKbJobFixture(t)
	jobEvents := recordKbEvents(protocol.EventKbJobUpdated, f.baseID)
	draftEvents := recordKbEvents(protocol.EventKbDraftUpdated, f.baseID)
	mrEvents := recordKbEvents(protocol.EventKbMrCreated, f.baseID)

	created := createKbJob(t, f.slug, map[string]any{
		"agent_id": f.agentID, "starter": kb.StarterAnnotations, "name": "处理批注",
		"message": "Handle the annotation.", "annotation_ids": []string{f.annotationID},
	}, http.StatusCreated)
	jobID, _ := created["id"].(string)
	if created["draft_id"] != nil || created["draft"] != nil || created["state"] != kbJobStateRunning || created["name"] != "处理批注" {
		t.Fatalf("created job = %v", created)
	}
	sessionID, _ := created["chat_session_id"].(string)
	assertChatSessionSource(t, sessionID, protocol.ChatSessionSourceKbJob)

	// The first message is the member's request as sent; handling
	// annotations needs no hidden instruction.
	if got := kbJobInput(t, sessionID); len(got) != 1 || got[0] != (kbJobInputRow{protocol.ChatMessageKindMessage, "Handle the annotation."}) {
		t.Fatalf("first turn input = %+v", got)
	}

	// The job's chat stays out of the chat list.
	sessions, err := testHandler.Queries.ListChatSessionsByCreator(context.Background(), db.ListChatSessionsByCreatorParams{
		WorkspaceID: parseUUID(testWorkspaceID), CreatorID: parseUUID(testUserID), Source: protocol.ChatSessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range sessions {
		if uuidToString(s.ID) == sessionID {
			t.Error("job chat is listed among chats")
		}
	}

	// Before the agent links a draft: empty right side, submit refused.
	detail := getKbJob(t, jobID, nil, http.StatusOK)
	if detail.DraftID != nil || len(detail.Pages) != 0 || detail.Checks.Lint == nil {
		t.Errorf("job before draft = %+v", detail)
	}
	if got := postKbJobAction(t, testHandler.SubmitKbJob, jobID, nil, http.StatusConflict); got["code"] != kbCodeJobNoDraft {
		t.Errorf("submit without draft = %v", got)
	}

	// The agent runs on someone else's runtime: its token is bound to that
	// person, who therefore owns the draft.
	runtimeOwner := createPlainMember(t, fmt.Sprintf("kb-job-owner-%d@marvis.ai", time.Now().UnixNano()))
	var taskID string
	dbfx.QueryRow(t, `SELECT id FROM agent_task_queue WHERE chat_session_id = $1`, sessionID).Scan(&taskID)
	agent := asJobAgent(runtimeOwner, f.agentID, taskID)
	// No job id: running in the job's chat links the draft to the job.
	draftReq := newRequest(http.MethodPost, "/api/kb/drafts", map[string]any{"knowledge_base": f.slug, "title": "t"})
	agent(draftReq)
	var draft KbDraftResponse
	testutil.Call(t, testHandler.CreateKbDraft, draftReq).Want(http.StatusCreated).JSON(&draft)
	if draft.JobID == nil || *draft.JobID != jobID {
		t.Fatalf("draft created in the job chat = %+v, want job %s", draft, jobID)
	}
	draftID := draft.ID
	if n := len(jobEvents.all()); n < 2 {
		t.Errorf("kb.job.updated events = %d, want job created and draft linked", n)
	}

	head := kbPageHead(t, f.pageID)
	blocks := blockIDsOf(t, kbFetch(t, f.pageID, "detail=with-ids", http.StatusOK))
	opsReq := testutil.WithURLParams(newRequest(http.MethodPost, "/api/kb/drafts/x/pages/x/ops", map[string]any{
		"version": head,
		"ops":     []map[string]any{{"op": kb.OpBlockReplace, "block": blocks[1], "content": "Dedup by channel transaction id."}},
	}), "draftId", draftID, "id", url.PathEscape(f.pageID))
	agent(opsReq)
	testutil.Call(t, testHandler.ApplyKbPageOps, opsReq).Want(http.StatusOK)

	// The job creator reads the agent's draft, but cannot write it.
	detail = getKbJob(t, jobID, nil, http.StatusOK)
	if detail.DraftID == nil || *detail.DraftID != draftID || len(detail.Pages) != 1 || detail.Draft.Added != 1 || detail.Draft.Deleted != 1 {
		t.Fatalf("job with draft = %+v", detail)
	}
	draftDetail := kbDraftDetail(t, draftID)
	if len(draftDetail.Pages) != 1 {
		t.Errorf("job creator reading the draft = %+v", draftDetail)
	}
	kbOps(t, draftID, f.pageID, "d1", http.StatusForbidden, map[string]any{"op": kb.OpSetMeta, "fields": map[string]any{"description": "x"}})

	// One coalesced kb.draft.updated for the write, naming the job.
	deadline := time.Now().Add(2 * time.Second)
	for len(draftEvents.all()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := draftEvents.all(); len(got) != 1 || got[0]["job_id"] != jobID || got[0]["draft_id"] != draftID {
		t.Errorf("kb.draft.updated = %v", got)
	}

	// Submit waits for the turn to end.
	if got := postKbJobAction(t, testHandler.SubmitKbJob, jobID, nil, http.StatusConflict); got["code"] != kbCodeJobRunning {
		t.Errorf("submit while running = %v", got)
	}
	dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'completed' WHERE chat_session_id = $1`, sessionID)
	dbfx.Insert(t, "chat_message", testutil.Cols{
		"chat_session_id": sessionID, "role": "assistant", "task_id": taskID,
		"content": "## Dedup key is now the channel transaction id\n\nUpdated Callback.",
	})

	mr := postKbJobAction(t, testHandler.SubmitKbJob, jobID, map[string]any{}, http.StatusCreated)
	if mr["title"] != "Dedup key is now the channel transaction id" || mr["author_type"] != kbActorMember ||
		mr["source"] != kb.MergeRequestSourceAnnotations || mr["job_id"] != jobID || mr["status"] != kb.MergeRequestStatusOpen {
		t.Fatalf("merge request = %v", mr)
	}
	origin, _ := mr["origin"].(map[string]any)
	if origin["type"] != kbOriginJob || origin["ref_id"] != jobID {
		t.Errorf("origin = %v", origin)
	}

	var annotationStatus, draftStatus string
	dbfx.QueryRow(t, `SELECT status FROM kb_annotation WHERE id = $1`, f.annotationID).Scan(&annotationStatus)
	dbfx.QueryRow(t, `SELECT status FROM kb_draft WHERE id = $1`, draftID).Scan(&draftStatus)
	if annotationStatus != kb.AnnotationStatusProcessing || draftStatus != kb.DraftStatusSubmitted {
		t.Errorf("annotation %s, draft %s after submit", annotationStatus, draftStatus)
	}
	if len(mrEvents.all()) != 1 {
		t.Errorf("kb.mr.created events = %v", mrEvents.all())
	}

	detail = getKbJob(t, jobID, nil, http.StatusOK)
	if detail.MergeRequest == nil || detail.MergeRequest.Status != kb.MergeRequestStatusOpen || detail.MergeRequest.AuthorName == "" {
		t.Errorf("job after submit = %+v", detail.MergeRequest)
	}
	if got := postKbJobAction(t, testHandler.SubmitKbJob, jobID, nil, http.StatusConflict); got["code"] != kbCodeMergeRequestOpen {
		t.Errorf("second submit = %v", got)
	}
	if got := postKbJobAction(t, testHandler.DiscardKbJob, jobID, nil, http.StatusConflict); got["code"] != kbCodeMergeRequestOpen {
		t.Errorf("discard under review = %v", got)
	}

	// The agent keeps answering review comments in the submitted draft.
	kbOpsAs := testutil.WithURLParams(newRequest(http.MethodPost, "/api/kb/drafts/x/pages/x/ops", map[string]any{
		"version": "d1",
		"ops":     []map[string]any{{"op": kb.OpBlockReplace, "block": blocks[1], "content": "Dedup by channel transaction id, since 10-20."}},
	}), "draftId", draftID, "id", url.PathEscape(f.pageID))
	agent(kbOpsAs)
	testutil.Call(t, testHandler.ApplyKbPageOps, kbOpsAs).Want(http.StatusOK)
}

func TestKbJobPermissionsAndList(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbJobFixture(t)
	created := createKbJob(t, f.slug, map[string]any{
		"agent_id": f.agentID, "starter": kb.StarterCustom, "message": "Write the on-call page for payment callbacks",
	}, http.StatusCreated)
	jobID, _ := created["id"].(string)
	if created["name"] != "Write the on-call pa" {
		t.Errorf("custom job name = %v", created["name"])
	}

	other := createPlainMember(t, fmt.Sprintf("kb-job-other-%d@marvis.ai", time.Now().UnixNano()))
	getKbJob(t, jobID, func(r *http.Request) { r.Header.Set("X-User-ID", other) }, http.StatusForbidden)
	otherSubmit := testutil.WithURLParams(newRequestAs(other, http.MethodPost, "/api/kb/jobs/x/submit", nil), "jobId", jobID)
	testutil.Call(t, testHandler.SubmitKbJob, otherSubmit).Want(http.StatusForbidden)

	list := func(userID, query string) []KbJobResponse {
		req := testutil.WithURLParams(newRequestAs(userID, http.MethodGet, "/api/kb/bases/x/jobs"+query, nil), "kb", f.slug)
		var got []KbJobResponse
		testutil.Call(t, testHandler.ListKbJobs, req).Want(http.StatusOK).JSON(&got)

		return got
	}
	if mine := list(testUserID, ""); len(mine) != 1 || mine[0].ID != jobID || mine[0].AgentName == "" {
		t.Errorf("own jobs = %+v", mine)
	}
	if theirs := list(other, ""); len(theirs) != 0 {
		t.Errorf("another member sees %d jobs", len(theirs))
	}
	if running := list(testUserID, "?state=running"); len(running) != 1 {
		t.Errorf("running jobs = %d", len(running))
	}
	if failed := list(testUserID, "?state=failed"); len(failed) != 0 {
		t.Errorf("failed jobs = %d", len(failed))
	}
	req := testutil.WithURLParams(newRequest(http.MethodGet, "/api/kb/bases/x/jobs?state=nope", nil), "kb", f.slug)
	testutil.Call(t, testHandler.ListKbJobs, req).Want(http.StatusBadRequest)
}

func TestCreateKbJobRejects(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbJobFixture(t)
	body := func(over map[string]any) map[string]any {
		b := map[string]any{"agent_id": f.agentID, "starter": kb.StarterHealth, "message": "Check it."}
		for k, v := range over {
			b[k] = v
		}

		return b
	}

	if got := createKbJob(t, f.slug, body(map[string]any{"starter": "revert"}), http.StatusBadRequest); got["code"] != kbCodeInvalidJobStarter {
		t.Errorf("bad starter = %v", got)
	}
	createKbJob(t, f.slug, body(map[string]any{"message": "  "}), http.StatusBadRequest)

	other := insertTestKbBase(t, "Other", f.slug+"-o")
	otherPage := createTestKbPage(t, other, kb.NewPage{Slug: "x", Title: "X", Position: "a0", Markdown: "x"})
	if got := createKbJob(t, f.slug, body(map[string]any{"page_id": otherPage}), http.StatusBadRequest); got["code"] != kbCodePageNotFound {
		t.Errorf("page of another knowledge base = %v", got)
	}
	foreignAnnotation := dbfx.Insert(t, "kb_annotation", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": other, "body": "b", "author_type": kbActorMember, "author_id": testUserID,
	})
	if got := createKbJob(t, f.slug, body(map[string]any{"starter": kb.StarterAnnotations, "annotation_ids": []string{foreignAnnotation}}), http.StatusBadRequest); got["code"] != kbCodeAnnotationNotFound {
		t.Errorf("annotation of another knowledge base = %v", got)
	}

	unbound := dbfx.Agent(t, fmt.Sprintf("kb-job-unbound-%d", time.Now().UnixNano()), "")
	createKbJob(t, f.slug, body(map[string]any{"agent_id": unbound}), http.StatusUnprocessableEntity)

	owner := createPlainMember(t, fmt.Sprintf("kb-job-private-%d@marvis.ai", time.Now().UnixNano()))
	private := dbfx.Agent(t, fmt.Sprintf("kb-job-private-%d", time.Now().UnixNano()), handlerTestRuntimeID(t), testutil.Cols{"owner_id": owner})
	createKbJob(t, f.slug, body(map[string]any{"agent_id": private}), http.StatusForbidden)

	if n := dbfx.Count(t, `SELECT count(*) FROM kb_job WHERE knowledge_base_id = $1`, f.baseID); n != 0 {
		t.Errorf("rejected requests left %d jobs", n)
	}

	// A page brought in by "check this page" is kept on the job.
	created := createKbJob(t, f.slug, body(map[string]any{"page_id": f.pageID}), http.StatusCreated)
	if created["page_id"] != f.pageID {
		t.Errorf("health job page = %v", created["page_id"])
	}
}

// kbJobInputRow is one user row of a job's first turn.
type kbJobInputRow struct {
	kind, content string
}

// kbJobInput reads the first turn's input batch in the order the agent
// receives it.
func kbJobInput(t *testing.T, sessionID string) []kbJobInputRow {
	t.Helper()

	rows, err := testPool.Query(context.Background(), `
		SELECT message_kind, content FROM chat_message
		WHERE chat_session_id = $1 AND role = 'user'
		ORDER BY created_at, id`, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	var out []kbJobInputRow
	for rows.Next() {
		var row kbJobInputRow
		if err := rows.Scan(&row.kind, &row.content); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}

	return out
}

// TestCreateKbJobStoresTheVisibleMessage: the member's request is stored and
// shown exactly as sent. Starters whose request is a multi-step process add
// their steps as a hidden instruction ahead of it in the same turn; the
// member's chat never lists it.
func TestCreateKbJobStoresTheVisibleMessage(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbJobFixture(t)
	visible := "把下面的资料收录进[Job KB](mention://kb/" + f.baseID + ")：\n- `spec-v3.pdf`\n- `渠道对接.md`"
	created := createKbJob(t, f.slug, map[string]any{
		"agent_id": f.agentID, "starter": kb.StarterIngest, "name": "收录资料", "message": visible,
	}, http.StatusCreated)
	sessionID, _ := created["chat_session_id"].(string)

	instruction, err := kb.JobInstruction(kb.StarterIngest)
	if err != nil || instruction == "" {
		t.Fatalf("ingest instruction = %q, %v", instruction, err)
	}
	want := []kbJobInputRow{{protocol.ChatMessageKindInstruction, instruction}, {protocol.ChatMessageKindMessage, visible}}
	if got := kbJobInput(t, sessionID); !slices.Equal(got, want) {
		t.Fatalf("first turn input = %+v\nwant %+v", got, want)
	}

	// The member's chat shows the request alone, unchanged.
	req := withChatTestWorkspaceCtx(t, testutil.WithURLParams(newRequest(http.MethodGet, "/api/chat/sessions/x/messages", nil), "sessionId", sessionID))
	var shown []ChatMessageResponse
	testutil.Call(t, testHandler.ListChatMessages, req).Want(http.StatusOK).JSON(&shown)
	if len(shown) != 1 || shown[0].Content != visible || shown[0].MessageKind != protocol.ChatMessageKindMessage {
		t.Errorf("member's chat = %+v", shown)
	}

	// A free-text job sends the member's text alone.
	custom := createKbJob(t, f.slug, map[string]any{
		"agent_id": f.agentID, "starter": kb.StarterCustom, "message": "把退款排障那页拆成两页",
	}, http.StatusCreated)
	customSession, _ := custom["chat_session_id"].(string)
	if got := kbJobInput(t, customSession); len(got) != 1 || got[0] != (kbJobInputRow{protocol.ChatMessageKindMessage, "把退款排障那页拆成两页"}) {
		t.Errorf("custom job input = %+v", got)
	}
}

// TestCreateKbDraftLinksTheJobOfTheCallingChat: an agent's kb draft create in
// a job's chat links the draft to that job; a draft created anywhere else, or
// for another knowledge base, stays unlinked, and a job_id in the body links
// nothing; a second draft in the same job is refused with the first one's id.
func TestCreateKbDraftLinksTheJobOfTheCallingChat(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbJobFixture(t)
	startJob := func() (jobID, taskID string) {
		created := createKbJob(t, f.slug, map[string]any{"agent_id": f.agentID, "starter": kb.StarterCustom, "message": "m"}, http.StatusCreated)
		jobID, _ = created["id"].(string)
		dbfx.QueryRow(t, `SELECT id FROM agent_task_queue WHERE chat_session_id = $1`, created["chat_session_id"]).Scan(&taskID)

		return jobID, taskID
	}
	createDraft := func(baseRef string, body map[string]any, mutate func(*http.Request), want int) map[string]any {
		body["knowledge_base"] = baseRef
		req := newRequest(http.MethodPost, "/api/kb/drafts", body)
		if mutate != nil {
			mutate(req)
		}

		return testutil.Call(t, testHandler.CreateKbDraft, req).Want(want).Map()
	}

	jobID, taskID := startJob()
	inJob := asJobAgent(testUserID, f.agentID, taskID)
	first := createDraft(f.slug, map[string]any{}, inJob, http.StatusCreated)
	if first["job_id"] != jobID {
		t.Fatalf("draft in the job chat = %v, want job %s", first, jobID)
	}
	if got := createDraft(f.slug, map[string]any{}, inJob, http.StatusConflict); got["code"] != kbCodeJobDraftExists || got["draft_id"] != first["id"] {
		t.Errorf("second draft in the job chat = %v", got)
	}

	// Another knowledge base from inside the job chat: no link.
	other := insertTestKbBase(t, "Other", f.slug+"-o")
	if got := createDraft(other, map[string]any{}, inJob, http.StatusCreated); got["job_id"] != nil {
		t.Errorf("draft of another knowledge base = %v", got)
	}

	// A task outside any job chat: no link.
	outside := dbfx.Task(t, f.agentID, testutil.Cols{"runtime_id": handlerTestRuntimeID(t)})
	if got := createDraft(f.slug, map[string]any{}, asJobAgent(testUserID, f.agentID, outside), http.StatusCreated); got["job_id"] != nil {
		t.Errorf("draft outside a job chat = %v", got)
	}
	if got := createDraft(f.slug, map[string]any{}, nil, http.StatusCreated); got["job_id"] != nil {
		t.Errorf("member's draft = %v", got)
	}

	// A job_id in the body is not read: the draft stays unlinked.
	otherJob, _ := startJob()
	if got := createDraft(f.slug, map[string]any{"job_id": otherJob}, nil, http.StatusCreated); got["job_id"] != nil {
		t.Errorf("draft with job_id in the body = %v", got)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM kb_job_draft WHERE job_id = $1`, otherJob); n != 0 {
		t.Errorf("job_id in the body linked %d drafts", n)
	}
}

// TestKbJobDraftEndings covers a draft the agent submits itself, an empty
// draft, a draft failing its checks, and discarding.
func TestKbJobDraftEndings(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbJobFixture(t)
	newJob := func() (string, string) {
		created := createKbJob(t, f.slug, map[string]any{"agent_id": f.agentID, "starter": kb.StarterNewPage, "message": "m"}, http.StatusCreated)
		jobID, _ := created["id"].(string)
		sessionID, _ := created["chat_session_id"].(string)
		dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'completed' WHERE chat_session_id = $1`, sessionID)

		return jobID, sessionID
	}
	linkDraft := func(jobID string) string {
		return createKbJobDraft(t, f, jobID)
	}

	// Empty draft: nothing to submit.
	emptyJob, _ := newJob()
	linkDraft(emptyJob)
	if got := postKbJobAction(t, testHandler.SubmitKbJob, emptyJob, nil, http.StatusConflict); got["code"] != kbCodeDraftEmpty {
		t.Errorf("empty draft submit = %v", got)
	}

	// A format error blocks submitting.
	lintJob, _ := newJob()
	lintDraft := linkDraft(lintJob)
	kbOps(t, lintDraft, f.pageID, kbPageHead(t, f.pageID), http.StatusOK, map[string]any{"op": kb.OpSetMeta, "fields": map[string]any{"description": nil}})
	if got := postKbJobAction(t, testHandler.SubmitKbJob, lintJob, nil, http.StatusConflict); got["code"] != kbCodeDraftCheckFailed {
		t.Errorf("lint error submit = %v", got)
	}

	// The agent submits itself with kb mr create: the job shows it.
	selfJob, _ := newJob()
	selfDraft := linkDraft(selfJob)
	kbOps(t, selfDraft, f.pageID, kbPageHead(t, f.pageID), http.StatusOK, map[string]any{"op": kb.OpSetMeta, "fields": map[string]any{"description": "new"}})
	mrReq := newRequest(http.MethodPost, "/api/kb/merge-requests", map[string]any{"draft_id": selfDraft, "title": "Describe callback"})
	var mr KbMergeRequestResponse
	testutil.Call(t, testHandler.CreateKbMergeRequest, mrReq).Want(http.StatusCreated).JSON(&mr)
	if mr.Source != kb.MergeRequestSourceNewPage || mr.JobID == nil || *mr.JobID != selfJob || mr.Number < 1 {
		t.Errorf("kb mr create = %+v", mr)
	}
	if detail := getKbJob(t, selfJob, nil, http.StatusOK); detail.MergeRequest == nil || detail.MergeRequest.Number != mr.Number {
		t.Errorf("job after kb mr create = %+v", detail.MergeRequest)
	}
	next := newRequest(http.MethodPost, "/api/kb/merge-requests", map[string]any{"draft_id": selfDraft, "title": "again"})
	testutil.Call(t, testHandler.CreateKbMergeRequest, next).Want(http.StatusConflict)

	// Discard keeps the job and marks the draft discarded.
	discardJob, _ := newJob()
	discardDraft := linkDraft(discardJob)
	discarded := postKbJobAction(t, testHandler.DiscardKbJob, discardJob, nil, http.StatusOK)
	draft, _ := discarded["draft"].(map[string]any)
	if draft["status"] != kb.DraftStatusDiscarded || discarded["draft_id"] != discardDraft {
		t.Errorf("discarded job = %v", discarded)
	}
	if got := postKbJobAction(t, testHandler.SubmitKbJob, discardJob, nil, http.StatusConflict); got["code"] != kbCodeDraftNotOpen {
		t.Errorf("submit after discard = %v", got)
	}
	noDraftJob, _ := newJob()
	if got := postKbJobAction(t, testHandler.DiscardKbJob, noDraftJob, nil, http.StatusConflict); got["code"] != kbCodeJobNoDraft {
		t.Errorf("discard without draft = %v", got)
	}
}

func jsonBody(v any) io.ReadCloser {
	raw, _ := json.Marshal(v)

	return io.NopCloser(bytes.NewReader(raw))
}
