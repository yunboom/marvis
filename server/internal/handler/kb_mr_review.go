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
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/dbid"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// Error codes of reviews (decision 107).
const (
	kbCodeReviewNotFound        = "review_not_found"
	kbCodeReviewNotPending      = "review_not_pending"
	kbCodeReviewEmpty           = "review_empty"
	kbCodeCommentNotFound       = "comment_not_found"
	kbCodeCommentPublished      = "comment_published"
	kbCodeChangesRequested      = "changes_requested"
	kbCodeNotChangesRequested   = "merge_request_not_changes_requested"
	kbCodeReviewMemberOnly      = "review_member_only"
	kbCodeMergeRequestOwnerOnly = "merge_request_owner_only"
	kbCodeReviewOwnMergeRequest = "review_own_merge_request"
)

// Inbox notifications of reviews.
const (
	// kbInboxChangesRequested tells the owner a review asked for changes.
	kbInboxChangesRequested = "kb_mr_changes_requested"
	// kbInboxReviewRequested tells reviewers the owner asked for review again.
	kbInboxReviewRequested = "kb_mr_review_requested"
	// kbInboxReviewNeeded tells the knowledge base maintainers a merge
	// request waits for their approval.
	kbInboxReviewNeeded    = "kb_mr_review_needed"
	kbInboxSeverity        = "action_required"
	kbInboxRecipientMember = "member"
)

// kbMaintainerRoles are the workspace roles that maintain every knowledge
// base, as isWorkspaceAdmin.
var kbMaintainerRoles = []string{"owner", "admin"}

// Notification kinds a merge request status change makes obsolete.
var (
	// kbInboxAwaitingReview no longer apply once a review asks for changes.
	kbInboxAwaitingReview = []string{kbInboxReviewNeeded, kbInboxReviewRequested}
	// kbInboxAwaitingOwner no longer applies once the owner asks for review again.
	kbInboxAwaitingOwner = []string{kbInboxChangesRequested}
	// kbInboxAllReview no longer apply once the merge request is merged or closed.
	kbInboxAllReview = []string{kbInboxReviewNeeded, kbInboxReviewRequested, kbInboxChangesRequested}
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

// mayReviewKbMergeRequest: any member reviews someone else's merge request;
// its owner reviews it only as a knowledge base maintainer, so a maintainer
// can send feedback to the agent working on their own job (decision 107).
func mayReviewKbMergeRequest(member db.Member, base db.KbBase, isOwner bool) bool {
	return !isOwner || canMaintainKb(member, base)
}

// KbMrReviewResponse is one review of a merge request.
type KbMrReviewResponse struct {
	ID             string  `json:"id"`
	MergeRequestID string  `json:"merge_request_id"`
	ReviewerUserID string  `json:"reviewer_user_id"`
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
// 201. Only members review; agents get 403 review_member_only. The owner
// reviews their own request only as a knowledge base maintainer, otherwise
// 403 review_own_merge_request.
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

	member, ok := h.workspaceMember(w, r, uuidToString(base.WorkspaceID))
	if !ok {
		return
	}
	owner, err := kbMergeRequestOwner(ctx, h.Queries, mr)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	if !mayReviewKbMergeRequest(member, base, uuidToString(owner) == userID) {
		writeErrorCode(w, http.StatusForbidden, kbCodeReviewOwnMergeRequest, "only a knowledge base maintainer reviews their own merge request")
		return
	}

	status := http.StatusCreated
	review, err := h.Queries.OpenKbMrReview(ctx, db.OpenKbMrReviewParams{
		WorkspaceID: mr.WorkspaceID, MergeRequestID: mr.ID, ReviewerUserID: parseUUID(userID), State: kb.ReviewStatePending,
	})
	if isNotFound(err) {
		status = http.StatusOK
		review, err = h.Queries.GetKbMrPendingReview(ctx, db.GetKbMrPendingReviewParams{
			MergeRequestID: mr.ID, ReviewerUserID: parseUUID(userID), State: kb.ReviewStatePending,
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
// pending review of the merge request: another member's review is 403, a
// submitted one 409 review_not_pending.
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
	if err != nil {
		writeErrorCode(w, http.StatusNotFound, kbCodeReviewNotFound, "review not found")
		return db.KbMergeRequest{}, db.KbBase{}, db.KbMrReview{}, false
	}
	if uuidToString(review.ReviewerUserID) != userID {
		writeErrorCode(w, http.StatusForbidden, kbCodeForbidden, "this review belongs to another member")
		return db.KbMergeRequest{}, db.KbBase{}, db.KbMrReview{}, false
	}
	if review.State != kb.ReviewStatePending {
		writeErrorCode(w, http.StatusConflict, kbCodeReviewNotPending, "the review is already submitted")
		return db.KbMergeRequest{}, db.KbBase{}, db.KbMrReview{}, false
	}

	return mr, base, review, true
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
// neither comments nor a summary is 409 review_empty.
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

	reviewerID := uuidToString(review.ReviewerUserID)
	h.publishKbMergeRequestEvent(protocol.EventKbMrUpdated, out.mr, kbActorMember, reviewerID, nil)
	h.publishKbMrCommented(out.mr, kbActorMember, reviewerID, pgtype.UUID{}, review.ID)
	h.publishKbMergeRequestJob(out.mr, db.KbDraft{ID: out.mr.DraftID}, kbActorMember, reviewerID)
	h.publishKbInbox(out.mr.WorkspaceID, out.inbox, kbActorMember, reviewerID)

	resp, err := h.kbMrReviewResponses(ctx, out.mr, []db.KbMrReview{out.review})
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, resp[0])
}

// kbReviewOutcome is what a review submit or a review request changed.
type kbReviewOutcome struct {
	mr     db.KbMergeRequest
	review db.KbMrReview
	inbox  kbInboxChanges
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
		return kbReviewOutcome{}, kbFail(http.StatusConflict, kbCodeReviewEmpty, "a review needs a comment or a summary")
	}

	submitted, err := qtx.SubmitKbMrReview(ctx, db.SubmitKbMrReviewParams{ID: review.ID, State: kb.ReviewStateSubmitted, Summary: summary})
	if err != nil {
		return kbReviewOutcome{}, errors.Wrapf(err, "submit review review_id=%s", uuidToString(review.ID))
	}
	updated, err := qtx.SetKbMergeRequestStatus(ctx, db.SetKbMergeRequestStatusParams{ID: mr.ID, Status: kb.MergeRequestStatusChangesRequested})
	if err != nil {
		return kbReviewOutcome{}, errors.Wrapf(err, "request changes merge_request_id=%s", uuidToString(mr.ID))
	}
	if err := recordKbMrEvent(ctx, qtx, updated, kbActorMember, uuidToString(review.ReviewerUserID), kbMrEventReviewSubmitted, map[string]any{
		"review_id": uuidToString(review.ID), "comment_count": commentCount, "summary": summary,
	}); err != nil {
		return kbReviewOutcome{}, err
	}

	// Nobody approves a request waiting on its owner; the owner, even when
	// they wrote the review themselves, has feedback to resolve.
	archived, err := archiveKbMrInboxItems(ctx, qtx, updated, kbInboxAwaitingReview)
	if err != nil {
		return kbReviewOutcome{}, err
	}
	owner, err := kbMergeRequestOwner(ctx, qtx, mr)
	if err != nil {
		return kbReviewOutcome{}, err
	}
	notified, err := createKbReviewInboxItems(ctx, qtx, kbReviewNotice{
		kind: kbInboxChangesRequested, base: base, mr: updated, review: submitted,
		actorType: kbActorMember, actorID: review.ReviewerUserID, recipients: []pgtype.UUID{owner}, body: summary,
	})
	if err != nil {
		return kbReviewOutcome{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return kbReviewOutcome{}, errors.Wrap(err, "commit review submit")
	}

	return kbReviewOutcome{mr: updated, review: submitted, inbox: kbInboxChanges{created: notified, archived: archived}}, nil
}

// RequestKbMrReview puts a changes_requested merge request back up for
// review (POST /api/kb/merge-requests/{number}/ready; kb mr ready): only its
// owner may. The maintainers are asked to approve it again and the other
// members who submitted a review on it are asked to review it again.
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
	h.publishKbInbox(out.mr.WorkspaceID, out.inbox, actorType, actorID)

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
	archived, err := archiveKbMrInboxItems(ctx, qtx, updated, kbInboxAwaitingOwner)
	if err != nil {
		return kbReviewOutcome{}, err
	}
	needed, maintainers, err := notifyKbReviewNeeded(ctx, qtx, base, updated, kbActorMember, owner)
	if err != nil {
		return kbReviewOutcome{}, err
	}

	// A maintainer who reviewed already has the approval notice above.
	reviewers, err := qtx.ListKbMrReviewerUserIDs(ctx, db.ListKbMrReviewerUserIDsParams{MergeRequestID: mr.ID, State: kb.ReviewStateSubmitted})
	if err != nil {
		return kbReviewOutcome{}, errors.Wrapf(err, "list reviewers merge_request_id=%s", uuidToString(mr.ID))
	}
	reviewers = slices.DeleteFunc(reviewers, func(id pgtype.UUID) bool { return slices.Contains(maintainers, id) })
	requested, err := createKbReviewInboxItems(ctx, qtx, kbReviewNotice{
		kind: kbInboxReviewRequested, base: base, mr: updated, actorType: kbActorMember, actorID: owner, recipients: reviewers,
	})
	if err != nil {
		return kbReviewOutcome{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return kbReviewOutcome{}, errors.Wrap(err, "commit review request")
	}

	return kbReviewOutcome{mr: updated, inbox: kbInboxChanges{created: append(needed, requested...), archived: archived}}, nil
}

// kbReviewNotice is one review notification to some members.
type kbReviewNotice struct {
	kind       string
	base       db.KbBase
	mr         db.KbMergeRequest
	review     db.KbMrReview
	actorType  string
	actorID    pgtype.UUID
	recipients []pgtype.UUID
	body       string
}

// createKbReviewInboxItems writes the notice to each recipient once in one
// statement; members who left the workspace are skipped. The actor is
// notified too: a maintainer reviews and merges their own requests.
func createKbReviewInboxItems(ctx context.Context, q *db.Queries, n kbReviewNotice) ([]db.InboxItem, error) {
	recipients := make([]pgtype.UUID, 0, len(n.recipients))
	for _, id := range n.recipients {
		if id.Valid && !slices.Contains(recipients, id) {
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
		ActorType:     n.actorType,
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

// kbInboxChanges are the review notifications one merge request change wrote
// and archived, published after its commit.
type kbInboxChanges struct {
	created []db.InboxItem
	// archived counts the archived notifications per recipient member.
	archived map[string]int64
}

// notifyKbReviewNeeded asks every maintainer of the knowledge base (canMaintainKb),
// the author and the owner included, to approve a merge request that was
// just opened or put back up for review. It returns the maintainers too.
func notifyKbReviewNeeded(ctx context.Context, q *db.Queries, base db.KbBase, mr db.KbMergeRequest, actorType string, actorID pgtype.UUID) ([]db.InboxItem, []pgtype.UUID, error) {
	maintainers, err := q.ListKbMaintainerUserIDs(ctx, db.ListKbMaintainerUserIDsParams{
		WorkspaceID: base.WorkspaceID,
		Roles:       kbMaintainerRoles,
		CreatorID:   base.CreatedBy,
	})
	if err != nil {
		return nil, nil, errors.Wrapf(err, "list maintainers knowledge_base_id=%s", uuidToString(base.ID))
	}

	items, err := createKbReviewInboxItems(ctx, q, kbReviewNotice{
		kind: kbInboxReviewNeeded, base: base, mr: mr, actorType: actorType, actorID: actorID, recipients: maintainers,
	})
	if err != nil {
		return nil, nil, err
	}

	return items, maintainers, nil
}

// archiveKbMrInboxItems archives the merge request's unarchived notifications
// of the given kinds, which no longer ask for action, and counts them per
// recipient member.
func archiveKbMrInboxItems(ctx context.Context, q *db.Queries, mr db.KbMergeRequest, kinds []string) (map[string]int64, error) {
	rows, err := q.ArchiveKbMrInboxItems(ctx, db.ArchiveKbMrInboxItemsParams{
		WorkspaceID:        mr.WorkspaceID,
		Types:              kinds,
		MergeRequestNumber: mr.Number,
	})
	if err != nil {
		return nil, errors.Wrapf(err, "archive review notifications merge_request_id=%s", uuidToString(mr.ID))
	}

	counts := make(map[string]int64, len(rows))
	for _, row := range rows {
		if row.RecipientType == kbInboxRecipientMember {
			counts[uuidToString(row.RecipientID)]++
		}
	}

	return counts, nil
}

// publishKbInbox sends inbox:batch-archived to each member whose review
// notifications were archived, then inbox:new for each written one.
func (h *Handler) publishKbInbox(workspaceID pgtype.UUID, c kbInboxChanges, actorType, actorID string) {
	wsID := uuidToString(workspaceID)
	for recipientID, count := range c.archived {
		h.publish(protocol.EventInboxBatchArchived, wsID, actorType, actorID, map[string]any{
			"recipient_id": recipientID,
			"count":        count,
		})
	}

	for _, item := range c.created {
		h.publish(protocol.EventInboxNew, uuidToString(item.WorkspaceID), actorType, actorID, map[string]any{
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
		actors[i] = kbActor{kind: kbActorMember, id: rv.ReviewerUserID}
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
			ReviewerUserID: uuidToString(rv.ReviewerUserID),
			ReviewerName:   names.name(kbActorMember, rv.ReviewerUserID),
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
