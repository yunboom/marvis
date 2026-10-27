package handler

import (
	"net/http"
	"net/url"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/testutil"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
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
