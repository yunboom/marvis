package handler

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/service"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// Error codes of the review hand-off.
const (
	kbCodeMergeRequestNotFromJob  = "merge_request_not_from_job"
	kbCodeHandoffJobCreatorOnly   = "job_creator_only"
	kbCodeHandoffNothingToResolve = "nothing_to_resolve"
)

// KbMrHandoffResponse is the chat turn the review feedback was sent in.
type KbMrHandoffResponse struct {
	ChatSessionID string `json:"chat_session_id"`
	MessageID     string `json:"message_id"`
	TaskID        string `json:"task_id"`
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
