package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/service"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// kbHandoffDefaultMessage is the hand-off line for clients that send none.
const kbHandoffDefaultMessage = "Resolve the review feedback on #%d"

// Error codes of the review hand-off.
const (
	kbCodeMergeRequestNotFromJob  = "merge_request_not_from_job"
	kbCodeHandoffJobCreatorOnly   = "job_creator_only"
	kbCodeHandoffNothingToResolve = "nothing_to_resolve"
)

// KbMrHandoffRequest carries the line the member's chat shows for the
// hand-off, written in the member's language by the client.
type KbMrHandoffRequest struct {
	Message string `json:"message"`
}

// KbMrHandoffResponse is the chat turn the review feedback was sent in.
type KbMrHandoffResponse struct {
	ChatSessionID string `json:"chat_session_id"`
	MessageID     string `json:"message_id"`
	TaskID        string `json:"task_id"`
}

// HandoffKbMrReview asks the agent of the job the merge request came from to
// resolve its review feedback (POST /api/kb/merge-requests/{number}/handoff),
// so it revises the same draft. The member's chat shows the short line the
// client sends; the steps go with it as a hidden instruction
// (kb.ReviewHandoffInstruction), and the agent reads the feedback itself.
// Only the job's creator may; the request must be changes_requested, come
// from a job and have submitted reviews still to resolve.
func (h *Handler) HandoffKbMrReview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	mr, _, ok := h.loadKbMergeRequest(w, r)
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

	// The body is optional: clients released before it existed send none.
	var req KbMrHandoffRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	message := strings.TrimSpace(req.Message)
	if message == "" {
		message = fmt.Sprintf(kbHandoffDefaultMessage, mr.Number)
	}

	if err := h.requireKbOpenReviewRound(ctx, mr); err != nil {
		h.writeKbError(w, r, err)
		return
	}
	instruction, err := kb.ReviewHandoffInstruction(int(mr.Number))
	if err != nil {
		h.writeKbInternalError(w, r, err)
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
	sent, err := h.TaskService.SendDirectChatMessageWithInstruction(ctx, session, agent, parseUUID(userID), message, instruction, nil, kbActorMember, parseUUID(userID))
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

// requireKbOpenReviewRound fails with nothing_to_resolve unless a review
// submitted since the owner last asked for review is waiting.
func (h *Handler) requireKbOpenReviewRound(ctx context.Context, mr db.KbMergeRequest) error {
	reviews, err := h.Queries.ListKbMrReviews(ctx, db.ListKbMrReviewsParams{MergeRequestID: mr.ID, SubmittedState: kb.ReviewStateSubmitted})
	if err != nil {
		return errors.Wrapf(err, "list reviews merge_request_id=%s", uuidToString(mr.ID))
	}
	if len(kbOpenReviewRound(mr, reviews)) == 0 {
		return kbFail(http.StatusConflict, kbCodeHandoffNothingToResolve, "no review feedback is waiting")
	}

	return nil
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
