package handler

import (
	"fmt"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/testutil"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// cleanupKbReviews removes the reviews, events and review notifications of
// a test knowledge base before its merge requests go.
func cleanupKbReviews(t *testing.T, baseID, slug string) {
	t.Helper()

	dbfx.Cleanup(t, `DELETE FROM inbox_item WHERE details->>'knowledge_base_slug' = $1`, slug)
	dbfx.Cleanup(t, `DELETE FROM kb_mr_event WHERE merge_request_id IN (SELECT id FROM kb_merge_request WHERE knowledge_base_id = $1)`, baseID)
	dbfx.Cleanup(t, `DELETE FROM kb_mr_review WHERE merge_request_id IN (SELECT id FROM kb_merge_request WHERE knowledge_base_id = $1)`, baseID)
	dbfx.Cleanup(t, `DELETE FROM kb_mr_comment WHERE merge_request_id IN (SELECT id FROM kb_merge_request WHERE knowledge_base_id = $1)`, baseID)
}

// kbReviewRequest addresses a review endpoint: kv adds reviewId / commentId.
func kbReviewRequest(method string, number int, body any, mutate func(*http.Request), kv ...string) *http.Request {
	params := append([]string{"number", strconv.Itoa(number)}, kv...)
	req := testutil.WithURLParams(newRequest(method, "/api/kb/merge-requests/x/reviews", body), params...)
	if mutate != nil {
		mutate(req)
	}

	return req
}

func openKbReview(t *testing.T, number int, mutate func(*http.Request), want int) KbMrReviewResponse {
	t.Helper()

	var got KbMrReviewResponse
	testutil.Call(t, testHandler.OpenKbMrReview, kbReviewRequest(http.MethodPost, number, map[string]any{}, mutate)).Want(want).JSON(&got)

	return got
}

func addKbReviewComment(t *testing.T, number int, reviewID string, body map[string]any, mutate func(*http.Request)) KbMrCommentResponse {
	t.Helper()

	body["review_id"] = reviewID
	var got KbMrCommentResponse
	testutil.Call(t, testHandler.CreateKbMrComment, kbMRRequest(http.MethodPost, number, body, mutate)).Want(http.StatusCreated).JSON(&got)

	return got
}

func submitKbReview(t *testing.T, number int, reviewID, summary string, mutate func(*http.Request), want int) map[string]any {
	t.Helper()

	req := kbReviewRequest(http.MethodPost, number, map[string]any{"summary": summary}, mutate, "reviewId", reviewID)

	return testutil.Call(t, testHandler.SubmitKbMrReview, req).Want(want).Map()
}

func listKbMrComments(t *testing.T, number int, state string, mutate func(*http.Request)) []KbMrCommentResponse {
	t.Helper()

	req := kbMRRequest(http.MethodGet, number, nil, mutate)
	if state != "" {
		req.URL.RawQuery = "state=" + state
	}
	var got []KbMrCommentResponse
	testutil.Call(t, testHandler.ListKbMrComments, req).Want(http.StatusOK).JSON(&got)

	return got
}

func kbInboxCount(t *testing.T, recipient, kind, slug string) int {
	t.Helper()

	var n int
	dbfx.QueryRow(t, `SELECT count(*) FROM inbox_item WHERE recipient_id = $1 AND type = $2 AND details->>'knowledge_base_slug' = $3`, recipient, kind, slug).Scan(&n)

	return n
}

// TestKbMrReviewFlow walks decision 107: a reviewer cannot comment outside a
// review; a review is opened once, its comments stay private until it is
// submitted, which moves the request to changes_requested and notifies the
// owner; the owner replies directly and asks for review again, which
// notifies the reviewer; the timeline merges comments and events.
func TestKbMrReviewFlow(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbReviewFixture(t)
	cleanupKbReviews(t, f.baseID, f.slug)
	updated := recordKbEvents(protocol.EventKbMrUpdated, f.baseID)
	reviewer := createPlainMember(t, fmt.Sprintf("kb-reviewer-%d@marvis.ai", time.Now().UnixNano()))
	asReviewer := asMember(reviewer)
	mr := openKbMR(t, f.draftWith(t, map[int]string{2: "Dedup by trade no."}))

	// Feedback goes through a review.
	if got := testutil.Call(t, testHandler.CreateKbMrComment, kbMRRequest(http.MethodPost, mr.Number, map[string]any{"body": "Why?"}, asReviewer)).
		Want(http.StatusForbidden).Map(); got["code"] != kbCodeReviewRequired {
		t.Errorf("comment outside a review = %v", got)
	}

	// Opening twice returns the same pending review.
	review := openKbReview(t, mr.Number, asReviewer, http.StatusCreated)
	if again := openKbReview(t, mr.Number, asReviewer, http.StatusOK); again.ID != review.ID || again.State != kb.ReviewStatePending {
		t.Fatalf("second open = %+v, want %s", again, review.ID)
	}

	comment := addKbReviewComment(t, mr.Number, review.ID, map[string]any{
		"body": "Say why the key changed.", "quote": map[string]any{"page_id": f.pageA, "block_id": f.blocks[2]},
	}, asReviewer)
	if comment.State != kbCommentStatePending || comment.ReviewID == nil || *comment.ReviewID != review.ID || comment.Quote == nil || comment.Quote.Text != "Dedup by trade no." {
		t.Fatalf("pending comment = %+v", comment)
	}
	extra := addKbReviewComment(t, mr.Number, review.ID, map[string]any{"body": "typo"}, asReviewer)

	// Pending comments show only to their reviewer, and only with state=all.
	if got := listKbMrComments(t, mr.Number, "", asReviewer); len(got) != 0 {
		t.Errorf("published comments before submit = %+v", got)
	}
	if got := listKbMrComments(t, mr.Number, kbCommentStateAll, asReviewer); len(got) != 2 || got[0].State != kbCommentStatePending {
		t.Errorf("reviewer's own comments = %+v", got)
	}
	if got := listKbMrComments(t, mr.Number, kbCommentStateAll, nil); len(got) != 0 {
		t.Errorf("owner sees pending comments = %+v", got)
	}
	testutil.Call(t, testHandler.ListKbMrComments, func() *http.Request {
		req := kbMRRequest(http.MethodGet, mr.Number, nil, nil)
		req.URL.RawQuery = "state=pending"
		return req
	}()).Want(http.StatusBadRequest)

	// Another member cannot write into the review.
	testutil.Call(t, testHandler.CreateKbMrComment, kbMRRequest(http.MethodPost, mr.Number, map[string]any{"body": "x", "review_id": review.ID}, nil)).
		Want(http.StatusForbidden)

	// Pending comments can be edited and removed by their author only.
	editReq := kbReviewRequest(http.MethodPatch, mr.Number, map[string]any{"body": "Say why the dedup key changed."}, asReviewer, "commentId", comment.ID)
	var edited KbMrCommentResponse
	testutil.Call(t, testHandler.UpdateKbMrComment, editReq).Want(http.StatusOK).JSON(&edited)
	if edited.Body != "Say why the dedup key changed." || edited.State != kbCommentStatePending {
		t.Errorf("edited = %+v", edited)
	}
	testutil.Call(t, testHandler.DeleteKbMrComment, kbReviewRequest(http.MethodDelete, mr.Number, nil, nil, "commentId", extra.ID)).
		Want(http.StatusForbidden)
	testutil.Call(t, testHandler.DeleteKbMrComment, kbReviewRequest(http.MethodDelete, mr.Number, nil, asReviewer, "commentId", extra.ID)).
		Want(http.StatusNoContent)

	// An empty review is refused; another member's review cannot be submitted.
	ownReview := openKbReview(t, mr.Number, nil, http.StatusCreated)
	if got := submitKbReview(t, mr.Number, ownReview.ID, " ", nil, http.StatusConflict); got["code"] != kbCodeReviewEmpty {
		t.Errorf("empty submit = %v", got)
	}
	submitKbReview(t, mr.Number, ownReview.ID, "mine", asReviewer, http.StatusForbidden)
	testutil.Call(t, testHandler.DiscardKbMrReview, kbReviewRequest(http.MethodDelete, mr.Number, nil, nil, "reviewId", ownReview.ID)).Want(http.StatusNoContent)

	// Submitting publishes the comments, requests changes and notifies the owner.
	if got := submitKbReview(t, mr.Number, review.ID, "One thing to fix.", asReviewer, http.StatusOK); got["state"] != kb.ReviewStateSubmitted || got["comment_count"] != float64(1) {
		t.Fatalf("submit = %v", got)
	}
	submitKbReview(t, mr.Number, review.ID, "again", asReviewer, http.StatusConflict)
	detail := getKbMR(t, mr.Number, nil)
	if detail.Status != kb.MergeRequestStatusChangesRequested || len(detail.Reviews) != 1 || detail.Reviews[0].Summary != "One thing to fix." ||
		!detail.CanRequestReview || detail.PendingReview != nil {
		t.Fatalf("detail after submit = %+v", detail)
	}
	if got := listKbMrComments(t, mr.Number, "", nil); len(got) != 1 || got[0].ID != comment.ID || got[0].State != kbCommentStatePublished {
		t.Errorf("published comments after submit = %+v", got)
	}
	if n := kbInboxCount(t, testUserID, kbInboxChangesRequested, f.slug); n != 1 {
		t.Errorf("owner notifications = %d, want 1", n)
	}
	if got := mergeKbMR(t, mr.Number, detail.DraftVersion, nil, http.StatusConflict); got["code"] != kbCodeChangesRequested {
		t.Errorf("merge while changes are requested = %v", got)
	}

	// Published comments cannot be edited.
	testutil.Call(t, testHandler.UpdateKbMrComment, kbReviewRequest(http.MethodPatch, mr.Number, map[string]any{"body": "late"}, asReviewer, "commentId", comment.ID)).
		Want(http.StatusConflict)

	// The owner replies directly; the reply is public at once.
	reply := postKbMrComment(t, mr.Number, map[string]any{"body": "Added the reason.", "parent_id": comment.ID}, nil, http.StatusCreated)
	if reply.ParentID == nil || *reply.ParentID != comment.ID || reply.ReviewID != nil || reply.State != kbCommentStatePublished {
		t.Errorf("owner reply = %+v", reply)
	}
	postKbMrComment(t, mr.Number, map[string]any{"body": "x", "parent_id": "00000000-0000-4000-8000-000000000000"}, nil, http.StatusBadRequest)
	postKbMrComment(t, mr.Number, map[string]any{"body": "top level"}, nil, http.StatusBadRequest)

	// Only the owner asks for review again; the reviewer is notified.
	testutil.Call(t, testHandler.RequestKbMrReview, kbMRRequest(http.MethodPost, mr.Number, nil, asReviewer)).Want(http.StatusForbidden)
	var ready KbMergeRequestResponse
	testutil.Call(t, testHandler.RequestKbMrReview, kbMRRequest(http.MethodPost, mr.Number, nil, nil)).Want(http.StatusOK).JSON(&ready)
	if ready.Status != kb.MergeRequestStatusOpen || ready.ReviewRequestedAt == nil {
		t.Errorf("ready = %+v", ready)
	}
	testutil.Call(t, testHandler.RequestKbMrReview, kbMRRequest(http.MethodPost, mr.Number, nil, nil)).Want(http.StatusConflict)
	if n := kbInboxCount(t, reviewer, kbInboxReviewRequested, f.slug); n != 1 {
		t.Errorf("reviewer notifications = %d, want 1", n)
	}
	if n := kbInboxCount(t, testUserID, kbInboxReviewRequested, f.slug); n != 0 {
		t.Errorf("owner notified of their own request = %d", n)
	}
	if n := len(updated.all()); n != 2 {
		t.Errorf("kb.mr.updated events = %d, want 2", n)
	}

	// An edit and the merge land in the timeline after the review.
	patch := kbMRRequest(http.MethodPatch, mr.Number, map[string]any{"title": "Dedup by trade no."}, nil)
	testutil.Call(t, testHandler.UpdateKbMergeRequest, patch).Want(http.StatusOK)
	mergeKbMR(t, mr.Number, detail.DraftVersion, nil, http.StatusOK)

	var timeline []struct {
		Type      string         `json:"type"`
		ID        string         `json:"id"`
		Kind      string         `json:"kind"`
		ActorName string         `json:"actor_name"`
		Payload   map[string]any `json:"payload"`
		Body      string         `json:"body"`
	}
	testutil.Call(t, testHandler.ListKbMrTimeline, kbMRRequest(http.MethodGet, mr.Number, nil, nil)).Want(http.StatusOK).JSON(&timeline)
	kinds := make([]string, 0, len(timeline))
	for _, e := range timeline {
		if e.Type == kbTimelineEvent {
			kinds = append(kinds, e.Kind)
			continue
		}
		kinds = append(kinds, kbTimelineComment)
	}
	want := fmt.Sprint([]string{kbTimelineComment, kbMrEventReviewSubmitted, kbTimelineComment, kbMrEventReviewRequested, kbMrEventEdited, kbMrEventMerged})
	if fmt.Sprint(kinds) != want {
		t.Errorf("timeline = %v, want %s", kinds, want)
	}
	if timeline[1].ActorName == "" || timeline[1].Payload["summary"] != "One thing to fix." || timeline[1].Payload["comment_count"] != float64(1) {
		t.Errorf("review event = %+v", timeline[1])
	}
}

// TestKbMrReviewDiscardAndClose: discarding drops the review and its
// comments; a changes_requested request can still be closed.
func TestKbMrReviewDiscardAndClose(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbReviewFixture(t)
	cleanupKbReviews(t, f.baseID, f.slug)
	reviewer := createPlainMember(t, fmt.Sprintf("kb-reviewer-%d@marvis.ai", time.Now().UnixNano()))
	asReviewer := asMember(reviewer)
	mr := openKbMR(t, f.draftWith(t, map[int]string{2: "Dedup by trade no."}))

	review := openKbReview(t, mr.Number, asReviewer, http.StatusCreated)
	addKbReviewComment(t, mr.Number, review.ID, map[string]any{"body": "drop me"}, asReviewer)
	testutil.Call(t, testHandler.DiscardKbMrReview, kbReviewRequest(http.MethodDelete, mr.Number, nil, asReviewer, "reviewId", review.ID)).Want(http.StatusNoContent)
	var left int
	dbfx.QueryRow(t, `SELECT count(*) FROM kb_mr_comment WHERE merge_request_id = $1`, mr.ID).Scan(&left)
	if left != 0 {
		t.Errorf("comments after discard = %d", left)
	}

	review = openKbReview(t, mr.Number, asReviewer, http.StatusCreated)
	submitKbReview(t, mr.Number, review.ID, "Not now.", asReviewer, http.StatusOK)
	closeReq := kbMRRequest(http.MethodPost, mr.Number, map[string]any{"reason": "superseded"}, nil)
	testutil.Call(t, testHandler.CloseKbMergeRequest, closeReq).Want(http.StatusOK)

	var payload string
	dbfx.QueryRow(t, `SELECT payload->>'close_reason' FROM kb_mr_event WHERE merge_request_id = $1 AND kind = $2`, mr.ID, kbMrEventClosed).Scan(&payload)
	if payload != "superseded" {
		t.Errorf("close event reason = %q", payload)
	}
	openKbReview(t, mr.Number, asReviewer, http.StatusConflict)
}

// TestKbMrReviewHandoff: the job's creator hands the open feedback to the
// job's agent as one message in the job's chat.
func TestKbMrReviewHandoff(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	f := newKbJobFixture(t)
	cleanupKbReviews(t, f.baseID, f.slug)
	_, sessionID, mr, _ := kbSubmittedJob(t, f)
	reviewer := createPlainMember(t, fmt.Sprintf("kb-reviewer-%d@marvis.ai", time.Now().UnixNano()))
	asReviewer := asMember(reviewer)

	handoff := kbMRRequest(http.MethodPost, mr.Number, nil, nil)
	testutil.Call(t, testHandler.HandoffKbMrReview, handoff).Want(http.StatusConflict)

	review := openKbReview(t, mr.Number, asReviewer, http.StatusCreated)
	comment := addKbReviewComment(t, mr.Number, review.ID, map[string]any{"body": "Say why."}, asReviewer)
	submitKbReview(t, mr.Number, review.ID, "One fix.", asReviewer, http.StatusOK)

	testutil.Call(t, testHandler.HandoffKbMrReview, kbMRRequest(http.MethodPost, mr.Number, nil, asReviewer)).Want(http.StatusForbidden)
	var got KbMrHandoffResponse
	testutil.Call(t, testHandler.HandoffKbMrReview, kbMRRequest(http.MethodPost, mr.Number, nil, nil)).Want(http.StatusCreated).JSON(&got)
	if got.ChatSessionID != sessionID || got.TaskID == "" {
		t.Errorf("handoff = %+v", got)
	}

	var content string
	dbfx.QueryRow(t, `SELECT content FROM chat_message WHERE chat_session_id = $1 AND role = 'user' ORDER BY created_at DESC LIMIT 1`, sessionID).Scan(&content)
	want, err := kb.ReviewHandoffMessage(kb.ReviewHandoffInput{
		Number: mr.Number, Title: mr.Title, DraftID: mr.DraftID,
		Summaries: []kb.ReviewHandoffSummary{{Reviewer: "AP Perm Member", Text: "One fix."}},
		Comments:  []kb.ReviewHandoffComment{{ID: comment.ID, Author: "AP Perm Member", Body: "Say why."}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if content != want {
		t.Errorf("job chat message:\n%s\nwant:\n%s", content, want)
	}
}
