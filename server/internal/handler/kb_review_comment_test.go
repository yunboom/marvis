package handler

import (
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/testutil"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

func postKbMrComment(t *testing.T, number int, body map[string]any, mutate func(*http.Request), want int) KbMrCommentResponse {
	t.Helper()

	var got KbMrCommentResponse
	rec := testutil.Call(t, testHandler.CreateKbMrComment, kbMRRequest(http.MethodPost, number, body, mutate)).Want(want)
	if want == http.StatusCreated {
		rec.JSON(&got)
	}

	return got
}

// kbSubmittedJob runs a job up to a submitted merge request: the agent links
// a draft and rewrites the annotated sentence, its turn ends, and the member
// submits. It returns the job, its chat, the merge request and the agent's
// request mutator.
func kbSubmittedJob(t *testing.T, f kbJobFixture) (string, string, KbMergeRequestResponse, func(*http.Request)) {
	t.Helper()

	created := createKbJob(t, f.slug, map[string]any{
		"agent_id": f.agentID, "starter": kb.StarterAnnotations, "message": "Handle it.", "annotation_ids": []string{f.annotationID},
	}, http.StatusCreated)
	jobID, _ := created["id"].(string)
	sessionID, _ := created["chat_session_id"].(string)

	var taskID string
	dbfx.QueryRow(t, `SELECT id FROM agent_task_queue WHERE chat_session_id = $1`, sessionID).Scan(&taskID)
	agent := asJobAgent(testUserID, f.agentID, taskID)
	draftID := createKbDraftAs(t, f.slug, func(r *http.Request) {
		agent(r)
		r.Body = jsonBody(map[string]any{"knowledge_base": f.slug, "job_id": jobID})
	})
	blocks := blockIDsOf(t, kbFetch(t, f.pageID, "detail=with-ids", http.StatusOK))
	opsReq := testutil.WithURLParams(newRequest(http.MethodPost, "/api/kb/drafts/x/pages/x/ops", map[string]any{
		"version": kbPageHead(t, f.pageID),
		"ops":     []map[string]any{{"op": kb.OpBlockReplace, "block": blocks[1], "content": "Dedup by channel transaction id."}},
	}), "draftId", draftID, "id", url.PathEscape(f.pageID))
	agent(opsReq)
	testutil.Call(t, testHandler.ApplyKbPageOps, opsReq).Want(http.StatusOK)
	dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'completed' WHERE chat_session_id = $1`, sessionID)

	var mr KbMergeRequestResponse
	req := testutil.WithURLParams(newRequest(http.MethodPost, "/api/kb/jobs/x/submit", map[string]any{"title": "Dedup", "summary": "s"}), "jobId", jobID)
	testutil.Call(t, testHandler.SubmitKbJob, req).Want(http.StatusCreated).JSON(&mr)

	return jobID, sessionID, mr, agent
}

// TestKbMrCommentsFromJob: on a request from a job, a member's comment goes
// to the job's agent as the 8.6 message in the job's own chat; replies stay
// one level deep, the agent's own reply starts nobody, and an @-mentioned
// agent gets a chat of its own that later comments reuse.
func TestKbMrCommentsFromJob(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbJobFixture(t)
	dbfx.Cleanup(t, `DELETE FROM kb_mr_comment WHERE merge_request_id IN (SELECT id FROM kb_merge_request WHERE knowledge_base_id = $1)`, f.baseID)
	commented := recordKbEvents(protocol.EventKbMrCommented, f.baseID)
	jobID, sessionID, mr, agent := kbSubmittedJob(t, f)
	if mr.Origin.Type != kbOriginJob || mr.Origin.RefID == nil || *mr.Origin.RefID != jobID {
		t.Fatalf("origin = %+v", mr.Origin)
	}

	blocks := blockIDsOf(t, kbFetch(t, f.pageID, "detail=with-ids", http.StatusOK))
	comment := postKbMrComment(t, mr.Number, map[string]any{
		"body":  "Say why the key changed.",
		"quote": map[string]any{"page_id": f.pageID, "block_id": blocks[1]},
	}, nil, http.StatusCreated)
	if comment.Quote == nil || comment.Quote.Text != "Dedup by channel transaction id." {
		t.Errorf("quote = %+v", comment.Quote)
	}
	if len(comment.Triggered) != 1 || comment.Triggered[0].AgentID != f.agentID || comment.Triggered[0].Reason != kb.TriggerReasonAuthor ||
		comment.Triggered[0].ChatSessionID == nil || *comment.Triggered[0].ChatSessionID != sessionID || !comment.Triggered[0].Running {
		t.Fatalf("triggered = %+v", comment.Triggered)
	}

	// The 8.6 message lands in the job's chat; no second job appears.
	var content string
	dbfx.QueryRow(t, `SELECT content FROM chat_message WHERE chat_session_id = $1 AND role = 'user' ORDER BY created_at DESC LIMIT 1`, sessionID).Scan(&content)
	want, err := kb.ReviewCommentMessage(kb.ReviewCommentInput{
		Number: mr.Number, Title: mr.Title, Author: comment.AuthorName, QuotePage: "Callback",
		QuoteText: "Dedup by channel transaction id.", Body: "Say why the key changed.", DraftID: mr.DraftID, CommentID: comment.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if content != want {
		t.Errorf("job chat message:\n%s\nwant:\n%s", content, want)
	}
	var jobs int
	dbfx.QueryRow(t, `SELECT count(*) FROM kb_job WHERE knowledge_base_id = $1`, f.baseID).Scan(&jobs)
	if jobs != 1 {
		t.Errorf("jobs = %d, want the original only", jobs)
	}

	// While the agent works, merging waits.
	detail := getKbMR(t, mr.Number, nil)
	if !detail.AgentRunning {
		t.Error("agent_running = false while the job's agent works on the comment")
	}
	if got := mergeKbMR(t, mr.Number, detail.DraftVersion, nil, http.StatusConflict); got["code"] != kbCodeJobRunning {
		t.Errorf("merge while the agent works = %v", got)
	}

	// The agent replies under the comment; that starts nobody. A reply to the
	// reply still hangs under the first comment.
	reply := postKbMrComment(t, mr.Number, map[string]any{"body": "Added the reason.", "parent_id": comment.ID}, agent, http.StatusCreated)
	if reply.ParentID == nil || *reply.ParentID != comment.ID || reply.AuthorType != kbActorAgent || len(reply.Triggered) != 0 {
		t.Errorf("agent reply = %+v", reply)
	}
	nested := postKbMrComment(t, mr.Number, map[string]any{"body": "[@all](mention://all/all) thanks", "parent_id": reply.ID}, nil, http.StatusCreated)
	if nested.ParentID == nil || *nested.ParentID != comment.ID || len(nested.Triggered) != 0 {
		t.Errorf("nested reply = %+v", nested)
	}
	postKbMrComment(t, mr.Number, map[string]any{"body": "x", "parent_id": "00000000-0000-4000-8000-000000000000"}, nil, http.StatusBadRequest)

	// Naming another agent starts it in a chat of its own, reused next time.
	other := createHandlerTestAgent(t, fmt.Sprintf("kb-review-other-%d", time.Now().UnixNano()), nil)
	mention := fmt.Sprintf("[@Other](mention://agent/%s) please check", other)
	first := postKbMrComment(t, mr.Number, map[string]any{"body": mention}, nil, http.StatusCreated)
	if len(first.Triggered) != 1 || first.Triggered[0].AgentID != other || first.Triggered[0].Reason != kb.TriggerReasonMention ||
		first.Triggered[0].ChatSessionID == nil || *first.Triggered[0].ChatSessionID == sessionID {
		t.Fatalf("mention triggered = %+v", first.Triggered)
	}
	otherChat := *first.Triggered[0].ChatSessionID
	dbfx.Cleanup(t, `DELETE FROM chat_session WHERE id = $1`, otherChat)
	var chatTitle string
	dbfx.QueryRow(t, `SELECT title FROM chat_session WHERE id = $1`, otherChat).Scan(&chatTitle)
	if chatTitle != fmt.Sprintf("#%d %s", mr.Number, mr.Title) {
		t.Errorf("review chat title = %q", chatTitle)
	}
	second := postKbMrComment(t, mr.Number, map[string]any{"body": mention}, nil, http.StatusCreated)
	if len(second.Triggered) != 1 || *second.Triggered[0].ChatSessionID != otherChat {
		t.Errorf("second mention = %+v, want chat %s", second.Triggered, otherChat)
	}

	var list []KbMrCommentResponse
	testutil.Call(t, testHandler.ListKbMrComments, kbMRRequest(http.MethodGet, mr.Number, nil, nil)).Want(http.StatusOK).JSON(&list)
	if len(list) != 5 || list[0].ID != comment.ID || list[0].Triggered[0].AgentName == "" {
		t.Errorf("comments = %+v", list)
	}
	if n := len(commented.all()); n != 5 {
		t.Errorf("kb.mr.commented events = %d, want 5", n)
	}
	postKbMrComment(t, mr.Number, map[string]any{"body": "  "}, nil, http.StatusBadRequest)
}

// TestKbMrCommentFromChat: a request an agent opened from a chat sends a
// member's comment back into that chat, and reports the chat as its origin.
func TestKbMrCommentFromChat(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbReviewFixture(t)
	agentID := createHandlerTestAgent(t, fmt.Sprintf("kb-review-chat-%d", time.Now().UnixNano()), nil)
	session := dbfx.Insert(t, "chat_session", testutil.Cols{
		"workspace_id": testWorkspaceID, "agent_id": agentID, "creator_id": testUserID, "title": "Talk about callbacks",
	})
	task := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": handlerTestRuntimeID(t), "chat_session_id": session, "status": "running"})
	agent := asJobAgent(testUserID, agentID, task)

	draftID := createKbDraftAs(t, f.slug, agent)
	opsReq := testutil.WithURLParams(newRequest(http.MethodPost, "/api/kb/drafts/x/pages/x/ops", map[string]any{
		"version": kbPageHead(t, f.pageA),
		"ops":     []map[string]any{{"op": kb.OpBlockReplace, "block": f.blocks[2], "content": "Dedup by trade no."}},
	}), "draftId", draftID, "id", f.pageA)
	agent(opsReq)
	testutil.Call(t, testHandler.ApplyKbPageOps, opsReq).Want(http.StatusOK)
	mrReq := newRequest(http.MethodPost, "/api/kb/merge-requests", map[string]any{"draft_id": draftID, "title": "From chat", "summary": "s"})
	agent(mrReq)
	var mr KbMergeRequestResponse
	testutil.Call(t, testHandler.CreateKbMergeRequest, mrReq).Want(http.StatusCreated).JSON(&mr)
	if mr.AuthorType != kbActorAgent || mr.Origin.Type != kbOriginChat || mr.Origin.RefID == nil || *mr.Origin.RefID != session || mr.Origin.Label != "Talk about callbacks" {
		t.Fatalf("merge request = %+v", mr)
	}

	dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'completed' WHERE id = $1`, task)
	comment := postKbMrComment(t, mr.Number, map[string]any{"body": "Cite the issue."}, nil, http.StatusCreated)
	if len(comment.Triggered) != 1 || comment.Triggered[0].AgentID != agentID || *comment.Triggered[0].ChatSessionID != session {
		t.Errorf("triggered = %+v", comment.Triggered)
	}
	var messages int
	dbfx.QueryRow(t, `SELECT count(*) FROM chat_message WHERE chat_session_id = $1 AND role = 'user'`, session).Scan(&messages)
	if messages != 1 {
		t.Errorf("messages in the original chat = %d, want 1", messages)
	}
}

// TestKbMergeRequestOrigin walks the spec 7.13 decision order.
func TestKbMergeRequestOrigin(t *testing.T) {
	id := func(n byte) pgtype.UUID { return pgtype.UUID{Bytes: [16]byte{n}, Valid: true} }
	mr := db.KbMergeRequest{}
	reverted := db.KbMergeRequest{Number: 15, Title: "Old"}

	cases := []struct {
		name     string
		mr       db.KbMergeRequest
		row      db.ListKbMergeRequestOriginsRow
		reverted *db.KbMergeRequest
		want     KbMergeRequestOriginResponse
	}{
		{name: "job first", mr: db.KbMergeRequest{RevertsID: id(9)},
			row:  db.ListKbMergeRequestOriginsRow{JobID: id(1), JobName: "处理批注", TaskIssueID: id(2)},
			want: KbMergeRequestOriginResponse{Type: kbOriginJob, Label: "处理批注", RefID: uuidToPtr(id(1))}},
		{name: "then revert", mr: db.KbMergeRequest{RevertsID: id(9)}, reverted: &reverted,
			row:  db.ListKbMergeRequestOriginsRow{TaskIssueID: id(2)},
			want: KbMergeRequestOriginResponse{Type: kbOriginRevert, Label: "#15 Old", RefID: uuidToPtr(id(9))}},
		{name: "then an autopilot run", mr: mr,
			row:  db.ListKbMergeRequestOriginsRow{TaskAutopilotRunID: id(3), AutopilotID: id(4), AutopilotTitle: "每日收录", TaskIssueID: id(2)},
			want: KbMergeRequestOriginResponse{Type: kbOriginAutopilotRun, Label: "每日收录", RefID: uuidToPtr(id(4))}},
		{name: "then an issue", mr: mr,
			row:  db.ListKbMergeRequestOriginsRow{TaskIssueID: id(2), IssueTitle: "Refund", TaskChatSessionID: id(5)},
			want: KbMergeRequestOriginResponse{Type: kbOriginIssue, Label: "Refund", RefID: uuidToPtr(id(2))}},
		{name: "then a chat", mr: mr,
			row:  db.ListKbMergeRequestOriginsRow{TaskChatSessionID: id(5), ChatTitle: "Talk"},
			want: KbMergeRequestOriginResponse{Type: kbOriginChat, Label: "Talk", RefID: uuidToPtr(id(5))}},
		{name: "else none", mr: mr, want: KbMergeRequestOriginResponse{Type: kbOriginNone}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := kbMergeRequestOrigin(tc.mr, tc.row, tc.reverted)
			if got.Type != tc.want.Type || got.Label != tc.want.Label || (got.RefID == nil) != (tc.want.RefID == nil) ||
				(got.RefID != nil && *got.RefID != *tc.want.RefID) {
				t.Errorf("origin = %+v, want %+v", got, tc.want)
			}
		})
	}
}
