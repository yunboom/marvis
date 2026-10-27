package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/service"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/dbid"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// Error codes of reviews (decision 107).
const (
	kbCodeReviewNotFound          = "review_not_found"
	kbCodeReviewNotPending        = "review_not_pending"
	kbCodeReviewEmpty             = "review_empty"
	kbCodeCommentNotFound         = "comment_not_found"
	kbCodeChangesRequested        = "changes_requested"
	kbCodeNotChangesRequested     = "merge_request_not_changes_requested"
	kbCodeMergeRequestNotFromJob  = "merge_request_not_from_job"
	kbCodeReviewMemberOnly        = "review_member_only"
	kbCodeMergeRequestOwnerOnly   = "merge_request_owner_only"
	kbCodeHandoffJobCreatorOnly   = "job_creator_only"
	kbCodeHandoffNothingToResolve = "nothing_to_resolve"
)

// Inbox notifications of reviews.
const (
	// kbInboxChangesRequested tells the owner a review asked for changes.
	kbInboxChangesRequested = "kb_mr_changes_requested"
	// kbInboxReviewRequested tells reviewers the owner asked for review again.
	kbInboxReviewRequested = "kb_mr_review_requested"
	kbInboxSeverity        = "action_required"
	kbInboxRecipientMember = "member"
)

// Merge request event kinds (kb_mr_event.kind).
const (
	// kbMrEventReviewSubmitted carries review_id and comment_count.
	kbMrEventReviewSubmitted = "review_submitted"
	kbMrEventReviewRequested = "review_requested"
	kbMrEventMerged          = "merged"
	// kbMrEventClosed carries close_reason.
	kbMrEventClosed = "closed"
	// kbMrEventReverted carries the number of the revert merge request.
	kbMrEventReverted = "reverted"
	// kbMrEventEdited carries the fields that changed.
	kbMrEventEdited = "edited"
)

// recordKbMrEvent writes one event of the merge request through q, inside
// the transaction of the change it records.
func recordKbMrEvent(ctx context.Context, q *db.Queries, mr db.KbMergeRequest, actorType, actorID, kind string, payload map[string]any) error {
	if payload == nil {
		payload = map[string]any{}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return errors.WithStack(err)
	}

	err = q.CreateKbMrEvent(ctx, db.CreateKbMrEventParams{
		WorkspaceID:    mr.WorkspaceID,
		MergeRequestID: mr.ID,
		ActorType:      actorType,
		ActorID:        parseUUID(actorID),
		Kind:           kind,
		Payload:        raw,
	})

	return errors.Wrapf(err, "record merge request event merge_request_id=%s kind=%s", uuidToString(mr.ID), kind)
}

// kbActiveMergeRequestStatuses are the statuses still under review: waiting
// on reviewers (open) or on the owner (changes_requested).
var kbActiveMergeRequestStatuses = []string{kb.MergeRequestStatusOpen, kb.MergeRequestStatusChangesRequested}

func isKbMergeRequestActive(status string) bool {
	return slices.Contains(kbActiveMergeRequestStatuses, status)
}

// KbMrReviewResponse is one review of a merge request.
type KbMrReviewResponse struct {
	ID             string  `json:"id"`
	MergeRequestID string  `json:"merge_request_id"`
	ReviewerID     string  `json:"reviewer_id"`
	ReviewerName   string  `json:"reviewer_name"`
	State          string  `json:"state"`
	Summary        string  `json:"summary"`
	CommentCount   int64   `json:"comment_count"`
	CreatedAt      string  `json:"created_at"`
	SubmittedAt    *string `json:"submitted_at"`
}

// SubmitKbMrReviewRequest submits a pending review with an optional summary.
type SubmitKbMrReviewRequest struct {
	Summary string `json:"summary"`
}

// UpdateKbMrReviewCommentRequest edits a pending comment.
type UpdateKbMrReviewCommentRequest struct {
	Body string `json:"body"`
}

// KbMrHandoffResponse is the chat turn the review feedback was sent in.
type KbMrHandoffResponse struct {
	ChatSessionID string `json:"chat_session_id"`
	MessageID     string `json:"message_id"`
	TaskID        string `json:"task_id"`
}

// ListKbMrReviews lists a merge request's submitted reviews, plus the
// viewer's pending one last (GET /api/kb/merge-requests/{number}/reviews).
func (h *Handler) ListKbMrReviews(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	mr, _, ok := h.loadKbMergeRequest(w, r)
	if !ok {
		return
	}

	resp, err := h.kbMrReviews(ctx, mr, parseUUID(userID))
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

// kbMrReviews renders the submitted reviews and, with viewer, the viewer's
// pending review.
func (h *Handler) kbMrReviews(ctx context.Context, mr db.KbMergeRequest, viewer pgtype.UUID) ([]KbMrReviewResponse, error) {
	rows, err := h.Queries.ListKbMrReviews(ctx, db.ListKbMrReviewsParams{
		MergeRequestID: mr.ID, SubmittedState: kb.ReviewStateSubmitted, ViewerID: viewer,
	})
	if err != nil {
		return nil, errors.Wrapf(err, "list reviews merge_request_id=%s", uuidToString(mr.ID))
	}

	return h.kbMrReviewResponses(ctx, mr, rows)
}

// OpenKbMrReview starts the caller's review (POST
// /api/kb/merge-requests/{number}/reviews). A member has one pending review
// per merge request: when it exists it is returned with 200, a new one with
// 201. Only members review; agents get 403 review_member_only.
func (h *Handler) OpenKbMrReview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	mr, base, ok := h.loadKbMergeRequest(w, r)
	if !ok {
		return
	}
	if actorType, _ := h.resolveActor(r, userID, uuidToString(base.WorkspaceID)); actorType != kbActorMember {
		writeErrorCode(w, http.StatusForbidden, kbCodeReviewMemberOnly, "only members review merge requests")
		return
	}
	if !isKbMergeRequestActive(mr.Status) {
		writeErrorCode(w, http.StatusConflict, kbCodeMergeRequestNotOpen, "the merge request is "+mr.Status)
		return
	}

	status := http.StatusCreated
	review, err := h.Queries.OpenKbMrReview(ctx, db.OpenKbMrReviewParams{
		WorkspaceID: mr.WorkspaceID, MergeRequestID: mr.ID, ReviewerID: parseUUID(userID), State: kb.ReviewStatePending,
	})
	if isNotFound(err) {
		status = http.StatusOK
		review, err = h.Queries.GetKbMrPendingReview(ctx, db.GetKbMrPendingReviewParams{
			MergeRequestID: mr.ID, ReviewerID: parseUUID(userID), State: kb.ReviewStatePending,
		})
	}
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "open review merge_request_id=%s", uuidToString(mr.ID)))
		return
	}

	resp, err := h.kbMrReviewResponses(ctx, mr, []db.KbMrReview{review})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, status, resp[0])
}

// loadKbMrPendingReview loads the {reviewId} URL param as the caller's own
// pending review of the merge request. Other members' reviews are not
// found; a submitted one is 409 review_not_pending.
func (h *Handler) loadKbMrPendingReview(w http.ResponseWriter, r *http.Request) (db.KbMergeRequest, db.KbBase, db.KbMrReview, bool) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return db.KbMergeRequest{}, db.KbBase{}, db.KbMrReview{}, false
	}
	reviewID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "reviewId"), "review_id")
	if !ok {
		return db.KbMergeRequest{}, db.KbBase{}, db.KbMrReview{}, false
	}
	mr, base, ok := h.loadKbMergeRequest(w, r)
	if !ok {
		return db.KbMergeRequest{}, db.KbBase{}, db.KbMrReview{}, false
	}
	if actorType, _ := h.resolveActor(r, userID, uuidToString(base.WorkspaceID)); actorType != kbActorMember {
		writeErrorCode(w, http.StatusForbidden, kbCodeReviewMemberOnly, "only members review merge requests")
		return db.KbMergeRequest{}, db.KbBase{}, db.KbMrReview{}, false
	}

	review, err := h.Queries.GetKbMrReview(r.Context(), db.GetKbMrReviewParams{MergeRequestID: mr.ID, ID: reviewID})
	if err != nil && !isNotFound(err) {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load review review_id=%s", uuidToString(reviewID)))
		return db.KbMergeRequest{}, db.KbBase{}, db.KbMrReview{}, false
	}
	if err != nil || uuidToString(review.ReviewerID) != userID {
		writeErrorCode(w, http.StatusNotFound, kbCodeReviewNotFound, "review not found")
		return db.KbMergeRequest{}, db.KbBase{}, db.KbMrReview{}, false
	}
	if review.State != kb.ReviewStatePending {
		writeErrorCode(w, http.StatusConflict, kbCodeReviewNotPending, "the review is already submitted")
		return db.KbMergeRequest{}, db.KbBase{}, db.KbMrReview{}, false
	}

	return mr, base, review, true
}

// CreateKbMrReviewComment adds a pending comment to the caller's review
// (POST /api/kb/merge-requests/{number}/reviews/{reviewId}/comments). It
// quotes a diff line like a direct comment and may reply to a published
// comment; nobody else sees it until the review is submitted.
func (h *Handler) CreateKbMrReviewComment(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req CreateKbMrCommentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Body) == "" {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "body is required")
		return
	}

	mr, base, review, ok := h.loadKbMrPendingReview(w, r)
	if !ok {
		return
	}
	if !isKbMergeRequestActive(mr.Status) {
		writeErrorCode(w, http.StatusConflict, kbCodeMergeRequestNotOpen, "the merge request is "+mr.Status)
		return
	}

	comment, err := h.createKbMrComment(ctx, base, mr, req, review.ID, kbActorMember, uuidToString(review.ReviewerID))
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	resp, err := h.kbMrCommentResponses(ctx, mr.WorkspaceID, []db.KbMrComment{comment}, review.ID)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusCreated, resp[0])
}

// loadKbMrReviewComment loads the {commentId} URL param as a comment of the
// caller's pending review.
func (h *Handler) loadKbMrReviewComment(w http.ResponseWriter, r *http.Request) (db.KbMergeRequest, db.KbMrReview, db.KbMrComment, bool) {
	commentID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "commentId"), "comment_id")
	if !ok {
		return db.KbMergeRequest{}, db.KbMrReview{}, db.KbMrComment{}, false
	}
	mr, _, review, ok := h.loadKbMrPendingReview(w, r)
	if !ok {
		return db.KbMergeRequest{}, db.KbMrReview{}, db.KbMrComment{}, false
	}

	comment, err := h.Queries.GetKbMrReviewComment(r.Context(), db.GetKbMrReviewCommentParams{MergeRequestID: mr.ID, ReviewID: review.ID, ID: commentID})
	if err != nil {
		if isNotFound(err) {
			writeErrorCode(w, http.StatusNotFound, kbCodeCommentNotFound, "comment not found in this review")
			return db.KbMergeRequest{}, db.KbMrReview{}, db.KbMrComment{}, false
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load review comment comment_id=%s", uuidToString(commentID)))
		return db.KbMergeRequest{}, db.KbMrReview{}, db.KbMrComment{}, false
	}

	return mr, review, comment, true
}

// UpdateKbMrReviewComment edits a pending comment (PATCH
// /api/kb/merge-requests/{number}/reviews/{reviewId}/comments/{commentId}).
func (h *Handler) UpdateKbMrReviewComment(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req UpdateKbMrReviewCommentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "body is required")
		return
	}

	mr, review, comment, ok := h.loadKbMrReviewComment(w, r)
	if !ok {
		return
	}

	updated, err := h.Queries.UpdateKbMrCommentBody(ctx, db.UpdateKbMrCommentBodyParams{ID: comment.ID, Body: body})
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "update review comment comment_id=%s", uuidToString(comment.ID)))
		return
	}

	resp, err := h.kbMrCommentResponses(ctx, mr.WorkspaceID, []db.KbMrComment{updated}, review.ID)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, resp[0])
}

// DeleteKbMrReviewComment removes a pending comment (DELETE
// /api/kb/merge-requests/{number}/reviews/{reviewId}/comments/{commentId}).
func (h *Handler) DeleteKbMrReviewComment(w http.ResponseWriter, r *http.Request) {
	_, _, comment, ok := h.loadKbMrReviewComment(w, r)
	if !ok {
		return
	}

	if err := h.Queries.DeleteKbMrComment(r.Context(), comment.ID); err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "delete review comment comment_id=%s", uuidToString(comment.ID)))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// DiscardKbMrReview drops the caller's pending review and its comments
// (DELETE /api/kb/merge-requests/{number}/reviews/{reviewId}).
func (h *Handler) DiscardKbMrReview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	mr, _, review, ok := h.loadKbMrPendingReview(w, r)
	if !ok {
		return
	}

	if err := h.discardKbMrReview(ctx, mr, review); err != nil {
		h.writeKbError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) discardKbMrReview(ctx context.Context, mr db.KbMergeRequest, review db.KbMrReview) error {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return errors.Wrap(err, "begin review discard")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	locked, err := qtx.GetKbMrReviewForUpdate(ctx, db.GetKbMrReviewForUpdateParams{MergeRequestID: mr.ID, ID: review.ID})
	if err != nil {
		return errors.Wrapf(err, "lock review review_id=%s", uuidToString(review.ID))
	}
	if locked.State != kb.ReviewStatePending {
		return kbFail(http.StatusConflict, kbCodeReviewNotPending, "the review is already submitted")
	}

	if err := qtx.DeleteKbMrReviewComments(ctx, db.DeleteKbMrReviewCommentsParams{MergeRequestID: mr.ID, ReviewID: review.ID}); err != nil {
		return errors.Wrapf(err, "delete review comments review_id=%s", uuidToString(review.ID))
	}
	if err := qtx.DeleteKbMrReview(ctx, review.ID); err != nil {
		return errors.Wrapf(err, "delete review review_id=%s", uuidToString(review.ID))
	}

	return errors.Wrap(tx.Commit(ctx), "commit review discard")
}

// SubmitKbMrReview publishes the caller's pending review (POST
// /api/kb/merge-requests/{number}/reviews/{reviewId}/submit): all its
// comments become visible at once, the merge request moves to
// changes_requested and its owner gets an inbox notification. A review with
// neither comments nor a summary is 422 review_empty.
func (h *Handler) SubmitKbMrReview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req SubmitKbMrReviewRequest
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
	}

	mr, base, review, ok := h.loadKbMrPendingReview(w, r)
	if !ok {
		return
	}

	out, err := h.submitKbMrReview(ctx, base, mr, review, strings.TrimSpace(req.Summary))
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	reviewerID := uuidToString(review.ReviewerID)
	h.publishKbMergeRequestEvent(protocol.EventKbMrUpdated, out.mr, kbActorMember, reviewerID, nil)
	h.publishKbMrCommented(out.mr, kbActorMember, reviewerID, pgtype.UUID{}, review.ID)
	h.publishKbMergeRequestJob(out.mr, db.KbDraft{ID: out.mr.DraftID}, kbActorMember, reviewerID)
	h.publishKbInboxItems(out.notified, reviewerID)

	resp, err := h.kbMrReviewResponses(ctx, out.mr, []db.KbMrReview{out.review})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, resp[0])
}

// kbReviewOutcome is what a review submit or a review request changed.
type kbReviewOutcome struct {
	mr       db.KbMergeRequest
	review   db.KbMrReview
	notified []db.InboxItem
}

func (h *Handler) submitKbMrReview(ctx context.Context, base db.KbBase, mr db.KbMergeRequest, review db.KbMrReview, summary string) (kbReviewOutcome, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return kbReviewOutcome{}, errors.Wrap(err, "begin review submit")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	locked, err := qtx.GetKbMergeRequestForUpdate(ctx, db.GetKbMergeRequestForUpdateParams{WorkspaceID: mr.WorkspaceID, ID: mr.ID})
	if err != nil {
		return kbReviewOutcome{}, errors.Wrapf(err, "lock merge request merge_request_id=%s", uuidToString(mr.ID))
	}
	if !isKbMergeRequestActive(locked.Status) {
		return kbReviewOutcome{}, kbFail(http.StatusConflict, kbCodeMergeRequestNotOpen, "the merge request is "+locked.Status)
	}
	current, err := qtx.GetKbMrReviewForUpdate(ctx, db.GetKbMrReviewForUpdateParams{MergeRequestID: mr.ID, ID: review.ID})
	if err != nil {
		return kbReviewOutcome{}, errors.Wrapf(err, "lock review review_id=%s", uuidToString(review.ID))
	}
	if current.State != kb.ReviewStatePending {
		return kbReviewOutcome{}, kbFail(http.StatusConflict, kbCodeReviewNotPending, "the review is already submitted")
	}

	counts, err := qtx.CountKbMrReviewComments(ctx, db.CountKbMrReviewCommentsParams{MergeRequestID: mr.ID, ReviewIds: []pgtype.UUID{review.ID}})
	if err != nil {
		return kbReviewOutcome{}, errors.Wrapf(err, "count review comments review_id=%s", uuidToString(review.ID))
	}
	var commentCount int64
	if len(counts) > 0 {
		commentCount = counts[0].CommentCount
	}
	if commentCount == 0 && summary == "" {
		return kbReviewOutcome{}, kbFail(http.StatusUnprocessableEntity, kbCodeReviewEmpty, "a review needs a comment or a summary")
	}

	submitted, err := qtx.SubmitKbMrReview(ctx, db.SubmitKbMrReviewParams{ID: review.ID, State: kb.ReviewStateSubmitted, Summary: summary})
	if err != nil {
		return kbReviewOutcome{}, errors.Wrapf(err, "submit review review_id=%s", uuidToString(review.ID))
	}
	updated, err := qtx.SetKbMergeRequestStatus(ctx, db.SetKbMergeRequestStatusParams{ID: mr.ID, Status: kb.MergeRequestStatusChangesRequested})
	if err != nil {
		return kbReviewOutcome{}, errors.Wrapf(err, "request changes merge_request_id=%s", uuidToString(mr.ID))
	}
	if err := recordKbMrEvent(ctx, qtx, updated, kbActorMember, uuidToString(review.ReviewerID), kbMrEventReviewSubmitted, map[string]any{
		"review_id": uuidToString(review.ID), "comment_count": commentCount,
	}); err != nil {
		return kbReviewOutcome{}, err
	}

	owner, err := kbMergeRequestOwner(ctx, qtx, mr)
	if err != nil {
		return kbReviewOutcome{}, err
	}
	notified, err := createKbReviewInboxItems(ctx, qtx, kbReviewNotice{
		kind: kbInboxChangesRequested, base: base, mr: updated, review: submitted,
		actorID: review.ReviewerID, recipients: []pgtype.UUID{owner}, body: summary,
	})
	if err != nil {
		return kbReviewOutcome{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return kbReviewOutcome{}, errors.Wrap(err, "commit review submit")
	}

	return kbReviewOutcome{mr: updated, review: submitted, notified: notified}, nil
}

// RequestKbMrReview puts a changes_requested merge request back up for
// review (POST /api/kb/merge-requests/{number}/ready; kb mr ready): only its
// owner may, and everyone who submitted a review on it is notified.
func (h *Handler) RequestKbMrReview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	mr, base, ok := h.loadKbMergeRequest(w, r)
	if !ok {
		return
	}
	owner, err := kbMergeRequestOwner(ctx, h.Queries, mr)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	if uuidToString(owner) != userID {
		writeErrorCode(w, http.StatusForbidden, kbCodeMergeRequestOwnerOnly, "only the owner of the merge request asks for review again")
		return
	}

	actorType, actorID := h.resolveActor(r, userID, uuidToString(base.WorkspaceID))
	out, err := h.requestKbMrReview(ctx, base, mr, owner, actorType, actorID)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	h.publishKbMergeRequestEvent(protocol.EventKbMrUpdated, out.mr, actorType, actorID, nil)
	h.publishKbMergeRequestJob(out.mr, db.KbDraft{ID: out.mr.DraftID}, actorType, actorID)
	h.publishKbInboxItems(out.notified, userID)

	resp, err := h.kbMergeRequestResponseOf(ctx, out.mr)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) requestKbMrReview(ctx context.Context, base db.KbBase, mr db.KbMergeRequest, owner pgtype.UUID, actorType, actorID string) (kbReviewOutcome, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return kbReviewOutcome{}, errors.Wrap(err, "begin review request")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	locked, err := qtx.GetKbMergeRequestForUpdate(ctx, db.GetKbMergeRequestForUpdateParams{WorkspaceID: mr.WorkspaceID, ID: mr.ID})
	if err != nil {
		return kbReviewOutcome{}, errors.Wrapf(err, "lock merge request merge_request_id=%s", uuidToString(mr.ID))
	}
	if locked.Status != kb.MergeRequestStatusChangesRequested {
		return kbReviewOutcome{}, kbFail(http.StatusConflict, kbCodeNotChangesRequested, "the merge request is "+locked.Status+", not changes_requested")
	}

	updated, err := qtx.SetKbMergeRequestStatus(ctx, db.SetKbMergeRequestStatusParams{ID: mr.ID, Status: kb.MergeRequestStatusOpen, ReviewRequested: true})
	if err != nil {
		return kbReviewOutcome{}, errors.Wrapf(err, "reopen merge request merge_request_id=%s", uuidToString(mr.ID))
	}
	if err := recordKbMrEvent(ctx, qtx, updated, actorType, actorID, kbMrEventReviewRequested, nil); err != nil {
		return kbReviewOutcome{}, err
	}
	reviewers, err := qtx.ListKbMrReviewerIDs(ctx, db.ListKbMrReviewerIDsParams{MergeRequestID: mr.ID, State: kb.ReviewStateSubmitted})
	if err != nil {
		return kbReviewOutcome{}, errors.Wrapf(err, "list reviewers merge_request_id=%s", uuidToString(mr.ID))
	}
	notified, err := createKbReviewInboxItems(ctx, qtx, kbReviewNotice{
		kind: kbInboxReviewRequested, base: base, mr: updated, actorID: owner, recipients: reviewers,
	})
	if err != nil {
		return kbReviewOutcome{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return kbReviewOutcome{}, errors.Wrap(err, "commit review request")
	}

	return kbReviewOutcome{mr: updated, notified: notified}, nil
}

// kbReviewNotice is one review notification to some members.
type kbReviewNotice struct {
	kind       string
	base       db.KbBase
	mr         db.KbMergeRequest
	review     db.KbMrReview
	actorID    pgtype.UUID
	recipients []pgtype.UUID
	body       string
}

// createKbReviewInboxItems writes the notice to each recipient but the actor
// in one statement; members who left the workspace are skipped.
func createKbReviewInboxItems(ctx context.Context, q *db.Queries, n kbReviewNotice) ([]db.InboxItem, error) {
	recipients := make([]pgtype.UUID, 0, len(n.recipients))
	for _, id := range n.recipients {
		if id.Valid && id != n.actorID && !slices.Contains(recipients, id) {
			recipients = append(recipients, id)
		}
	}
	if len(recipients) == 0 {
		return nil, nil
	}

	// The inbox reads the request and review live; details only point at them.
	details, err := json.Marshal(map[string]any{
		"knowledge_base_slug":  n.base.Slug,
		"merge_request_number": n.mr.Number,
		"review_id":            uuidToPtr(n.review.ID),
	})
	if err != nil {
		return nil, errors.WithStack(err)
	}
	ids := make([]pgtype.UUID, len(recipients))
	for i := range recipients {
		ids[i] = dbid.NewV7()
	}

	items, err := q.CreateKbMemberInboxItems(ctx, db.CreateKbMemberInboxItemsParams{
		WorkspaceID:   n.mr.WorkspaceID,
		RecipientType: kbInboxRecipientMember,
		Type:          n.kind,
		Severity:      kbInboxSeverity,
		Title:         fmt.Sprintf("#%d %s", n.mr.Number, n.mr.Title),
		Body:          n.body,
		ActorType:     kbActorMember,
		ActorID:       n.actorID,
		Details:       details,
		Ids:           ids,
		RecipientIds:  recipients,
	})
	if err != nil {
		return nil, errors.Wrapf(err, "create review notifications merge_request_id=%s type=%s", uuidToString(n.mr.ID), n.kind)
	}

	return items, nil
}

// publishKbInboxItems sends inbox:new for each written notification, in the
// item shape the inbox listener routes to its recipient.
func (h *Handler) publishKbInboxItems(items []db.InboxItem, actorID string) {
	for _, item := range items {
		h.publish(protocol.EventInboxNew, uuidToString(item.WorkspaceID), kbActorMember, actorID, map[string]any{
			"item": map[string]any{
				"id": uuidToString(item.ID), "workspace_id": uuidToString(item.WorkspaceID),
				"recipient_type": item.RecipientType, "recipient_id": uuidToString(item.RecipientID),
				"type": item.Type, "severity": item.Severity, "issue_id": nil,
				"issue_status": nil, "issue_priority": nil,
				"title": item.Title, "body": textToPtr(item.Body), "read": item.Read,
				"archived": item.Archived, "created_at": timestampToString(item.CreatedAt),
				"actor_type": textToPtr(item.ActorType), "actor_id": uuidToPtr(item.ActorID),
				"details": json.RawMessage(item.Details),
			},
		})
	}
}

// HandoffKbMrReview sends the review feedback still to be resolved into the
// chat of the job the merge request came from, as a message from the member
// (POST /api/kb/merge-requests/{number}/handoff), so the job's agent revises
// the same draft. Only the job's creator may; the request must be
// changes_requested and come from a job.
func (h *Handler) HandoffKbMrReview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	mr, base, ok := h.loadKbMergeRequest(w, r)
	if !ok {
		return
	}
	if mr.Status != kb.MergeRequestStatusChangesRequested {
		writeErrorCode(w, http.StatusConflict, kbCodeNotChangesRequested, "the merge request is "+mr.Status+", not changes_requested")
		return
	}

	origins, err := h.Queries.ListKbMergeRequestOrigins(ctx, db.ListKbMergeRequestOriginsParams{WorkspaceID: mr.WorkspaceID, DraftIds: []pgtype.UUID{mr.DraftID}})
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load merge request origin merge_request_id=%s", uuidToString(mr.ID)))
		return
	}
	if len(origins) == 0 || !origins[0].JobID.Valid {
		writeErrorCode(w, http.StatusConflict, kbCodeMergeRequestNotFromJob, "the merge request does not come from a knowledge base job")
		return
	}
	origin := origins[0]
	if uuidToString(origin.JobCreatedBy) != userID {
		writeErrorCode(w, http.StatusForbidden, kbCodeHandoffJobCreatorOnly, "only the member who started the job hands review feedback to its agent")
		return
	}

	message, err := h.kbReviewHandoffMessage(ctx, base, mr)
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}

	session, err := h.Queries.GetChatSessionInWorkspace(ctx, db.GetChatSessionInWorkspaceParams{ID: origin.JobChatSessionID, WorkspaceID: mr.WorkspaceID})
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load job chat chat_session_id=%s", uuidToString(origin.JobChatSessionID)))
		return
	}
	agent, err := h.Queries.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: origin.JobAgentID, WorkspaceID: mr.WorkspaceID})
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load job agent agent_id=%s", uuidToString(origin.JobAgentID)))
		return
	}
	sent, err := h.TaskService.SendDirectChatMessage(ctx, session, agent, parseUUID(userID), message, nil, kbActorMember, parseUUID(userID))
	if err != nil {
		if errors.Is(err, service.ErrChatTaskAgentNoRuntime) || errors.Is(err, service.ErrChatTaskAgentArchived) || errors.Is(err, service.ErrChatSessionArchived) {
			writeErrorCode(w, http.StatusUnprocessableEntity, kbCodeAgentUnavailable, "agent cannot run")
			return
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "hand review feedback to job agent merge_request_id=%s", uuidToString(mr.ID)))
		return
	}

	sessionID := uuidToString(session.ID)
	h.publishChat(protocol.EventChatMessage, uuidToString(mr.WorkspaceID), kbActorMember, userID, sessionID, protocol.ChatMessagePayload{
		ChatSessionID: sessionID,
		MessageID:     uuidToString(sent.Message.ID),
		Role:          kbChatRoleUser,
		Content:       message,
		TaskID:        uuidToString(sent.Task.ID),
		CreatedAt:     timestampToString(sent.Message.CreatedAt),
	})

	writeJSON(w, http.StatusCreated, KbMrHandoffResponse{ChatSessionID: sessionID, MessageID: uuidToString(sent.Message.ID), TaskID: uuidToString(sent.Task.ID)})
}

// kbReviewHandoffMessage renders the feedback still to be resolved: the
// reviews submitted since the owner last asked for review, with their
// summaries and comments.
func (h *Handler) kbReviewHandoffMessage(ctx context.Context, base db.KbBase, mr db.KbMergeRequest) (string, error) {
	reviews, err := h.Queries.ListKbMrReviews(ctx, db.ListKbMrReviewsParams{MergeRequestID: mr.ID, SubmittedState: kb.ReviewStateSubmitted})
	if err != nil {
		return "", errors.Wrapf(err, "list reviews merge_request_id=%s", uuidToString(mr.ID))
	}
	round := kbOpenReviewRound(mr, reviews)
	if len(round) == 0 {
		return "", kbFail(http.StatusConflict, kbCodeHandoffNothingToResolve, "no review feedback is waiting")
	}
	comments, err := h.listKbMrComments(ctx, mr, pgtype.UUID{})
	if err != nil {
		return "", err
	}
	overlay, err := loadKbOverlay(ctx, h.Queries, base.ID, mr.DraftID)
	if err != nil {
		return "", err
	}

	actors := make([]kbActor, 0, len(round)+len(comments))
	for _, rv := range round {
		actors = append(actors, kbActor{kind: kbActorMember, id: rv.ReviewerID})
	}
	for _, c := range comments {
		actors = append(actors, kbActor{kind: c.AuthorType, id: c.AuthorID})
	}
	names, err := h.loadKbActorNames(ctx, mr.WorkspaceID, actors)
	if err != nil {
		return "", err
	}

	in := kb.ReviewHandoffInput{Number: int(mr.Number), Title: mr.Title, DraftID: uuidToString(mr.DraftID)}
	inRound := make(map[pgtype.UUID]bool, len(round))
	for _, rv := range round {
		inRound[rv.ID] = true
		if rv.Summary != "" {
			in.Summaries = append(in.Summaries, kb.ReviewHandoffSummary{Reviewer: names.name(kbActorMember, rv.ReviewerID), Text: rv.Summary})
		}
	}
	for _, c := range comments {
		if !inRound[c.ReviewID] {
			continue
		}
		entry := kb.ReviewHandoffComment{ID: uuidToString(c.ID), Author: names.name(c.AuthorType, c.AuthorID), QuoteText: c.QuoteText, Body: c.Body}
		if c.QuoteBlockID != "" {
			entry.QuotePage = kbOverlayPageTitle(overlay, uuidOrEmpty(c.QuotePageID))
		}
		in.Comments = append(in.Comments, entry)
	}

	return kb.ReviewHandoffMessage(in)
}

// kbOpenReviewRound picks the submitted reviews still to be resolved: those
// submitted after the owner last asked for review (all, before the first).
func kbOpenReviewRound(mr db.KbMergeRequest, reviews []db.KbMrReview) []db.KbMrReview {
	out := make([]db.KbMrReview, 0, len(reviews))
	for _, rv := range reviews {
		if rv.State != kb.ReviewStateSubmitted {
			continue
		}
		if mr.ReviewRequestedAt.Valid && !rv.SubmittedAt.Time.After(mr.ReviewRequestedAt.Time) {
			continue
		}
		out = append(out, rv)
	}

	return out
}

// kbOverlayPageTitle names a page of the draft, falling back to its id.
func kbOverlayPageTitle(overlay kbOverlay, pageID string) string {
	if node, ok := overlay.tree.Node(pageID); ok && node.Title != "" {
		return node.Title
	}
	if row, ok := overlay.rows[pageID]; ok {
		if t, _ := row.header[kb.MetaTitle].(string); t != "" {
			return t
		}
	}

	return pageID
}

// kbMrReviewResponses renders reviews with their reviewer names and comment
// counts.
func (h *Handler) kbMrReviewResponses(ctx context.Context, mr db.KbMergeRequest, rows []db.KbMrReview) ([]KbMrReviewResponse, error) {
	out := make([]KbMrReviewResponse, 0, len(rows))
	if len(rows) == 0 {
		return out, nil
	}

	actors := make([]kbActor, len(rows))
	ids := make([]pgtype.UUID, len(rows))
	for i, rv := range rows {
		actors[i] = kbActor{kind: kbActorMember, id: rv.ReviewerID}
		ids[i] = rv.ID
	}
	names, err := h.loadKbActorNames(ctx, mr.WorkspaceID, actors)
	if err != nil {
		return nil, err
	}
	countRows, err := h.Queries.CountKbMrReviewComments(ctx, db.CountKbMrReviewCommentsParams{MergeRequestID: mr.ID, ReviewIds: ids})
	if err != nil {
		return nil, errors.Wrapf(err, "count review comments merge_request_id=%s", uuidToString(mr.ID))
	}
	counts := make(map[pgtype.UUID]int64, len(countRows))
	for _, c := range countRows {
		counts[c.ReviewID] = c.CommentCount
	}

	for _, rv := range rows {
		resp := KbMrReviewResponse{
			ID:             uuidToString(rv.ID),
			MergeRequestID: uuidToString(rv.MergeRequestID),
			ReviewerID:     uuidToString(rv.ReviewerID),
			ReviewerName:   names.name(kbActorMember, rv.ReviewerID),
			State:          rv.State,
			Summary:        rv.Summary,
			CommentCount:   counts[rv.ID],
			CreatedAt:      timestampToString(rv.CreatedAt),
		}
		if rv.SubmittedAt.Valid {
			at := timestampToString(rv.SubmittedAt)
			resp.SubmittedAt = &at
		}
		out = append(out, resp)
	}

	return out, nil
}
