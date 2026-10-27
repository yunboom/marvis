package handler

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/logger"
	"github.com/yunboom/marvis/server/internal/service"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/dbid"
)

// autopilotExecutionModeRunOnly is the execution mode whose runs execute as a
// bare agent task; only these runs carry a follow-up conversation.
const autopilotExecutionModeRunOnly = "run_only"

// Error codes of the run follow-up chat endpoint.
const (
	autopilotRunChatCodeModeUnsupported = "run_mode_unsupported"
	autopilotRunChatCodeNoSession       = "run_has_no_session"
)

// AutopilotRunChatResponse is the body of EnsureAutopilotRunChat.
type AutopilotRunChatResponse struct {
	ChatSessionID string `json:"chat_session_id"`
}

// EnsureAutopilotRunChat returns the follow-up chat session of a run_only run,
// creating it on first use. The run itself stays an autopilot task; the chat
// session continues the run task's provider session and work dir, so the
// second turn onward goes through the ordinary chat endpoints. A session
// created while the run executes starts without a resume pointer: the run's
// task writes it when it settles, and the claim query holds the session's
// messages until then.
func (h *Handler) EnsureAutopilotRunChat(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)

	autopilot, ok := h.loadAutopilotInWorkspace(w, r, chi.URLParam(r, "id"), workspaceID)
	if !ok {
		return
	}
	runUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "runId"), "run id")
	if !ok {
		return
	}
	run, err := h.Queries.GetAutopilotRun(r.Context(), runUUID)
	if err != nil || uuidToString(run.AutopilotID) != uuidToString(autopilot.ID) {
		writeError(w, http.StatusNotFound, "run not found")
		return
	}

	if autopilot.ExecutionMode != autopilotExecutionModeRunOnly {
		writeErrorCode(w, http.StatusConflict, autopilotRunChatCodeModeUnsupported, "only run_only runs have a conversation")
		return
	}
	if !run.TaskID.Valid {
		writeErrorCode(w, http.StatusConflict, autopilotRunChatCodeNoSession, "run has no agent task")
		return
	}
	task, err := h.Queries.GetAgentTask(r.Context(), run.TaskID)
	if err != nil {
		if isNotFound(err) {
			writeErrorCode(w, http.StatusConflict, autopilotRunChatCodeNoSession, "run has no agent task")
			return
		}
		h.writeAutopilotRunChatError(w, r, errors.Wrapf(err, "get run task run_id=%s", uuidToString(run.ID)))
		return
	}

	agent, err := h.Queries.GetAgentInWorkspace(r.Context(), db.GetAgentInWorkspaceParams{ID: task.AgentID, WorkspaceID: autopilot.WorkspaceID})
	if err != nil {
		writeError(w, http.StatusNotFound, "agent not found")
		return
	}
	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	if !h.canInvokeAgent(r.Context(), agent, actorType, actorID, h.invokeOriginatorFromRequest(r, actorType, actorID), workspaceID) {
		writeError(w, http.StatusForbidden, "you do not have access to this agent")
		return
	}

	if run.ChatSessionID.Valid {
		writeJSON(w, http.StatusOK, AutopilotRunChatResponse{ChatSessionID: uuidToString(run.ChatSessionID)})
		return
	}

	sessionID, err := h.ensureAutopilotRunChatSession(r.Context(), autopilot, run.ID, task.AgentID, userID)
	if err != nil {
		h.writeAutopilotRunChatError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, AutopilotRunChatResponse{ChatSessionID: uuidToString(sessionID)})
}

// ensureAutopilotRunChatSession creates the run's chat session under the run
// row lock, or returns the one a concurrent caller created first.
func (h *Handler) ensureAutopilotRunChatSession(ctx context.Context, autopilot db.Autopilot, runID, agentID pgtype.UUID, userID string) (pgtype.UUID, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return pgtype.UUID{}, errors.Wrap(err, "begin run chat create")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)

	run, err := qtx.LockAutopilotRunForUpdate(ctx, runID)
	if err != nil {
		return pgtype.UUID{}, errors.Wrapf(err, "lock run run_id=%s", uuidToString(runID))
	}
	if run.ChatSessionID.Valid {
		return run.ChatSessionID, nil
	}
	// Read under the run lock: a task settling concurrently locks the run
	// before it pins the pointer, so either its terminal status is visible
	// here or it sees the session linked below and pins it itself.
	task, err := qtx.GetAgentTask(ctx, run.TaskID)
	if err != nil {
		return pgtype.UUID{}, errors.Wrapf(err, "get run task run_id=%s", uuidToString(runID))
	}

	// Same workspace delete/create protocol every chat session creator follows
	// (see LockWorkspaceForChatSessionCreate).
	if _, err := qtx.LockWorkspaceForChatSessionCreate(ctx, autopilot.WorkspaceID); err != nil {
		return pgtype.UUID{}, errors.Wrapf(err, "lock workspace workspace_id=%s", uuidToString(autopilot.WorkspaceID))
	}
	projectID, err := lockRunChatProject(ctx, qtx, autopilot)
	if err != nil {
		return pgtype.UUID{}, err
	}

	session, err := qtx.CreateChatSession(ctx, db.CreateChatSessionParams{
		ID:          dbid.NewV7(),
		WorkspaceID: autopilot.WorkspaceID,
		AgentID:     agentID,
		CreatorID:   parseUUID(userID),
		Title:       autopilot.Title,
		ProjectID:   projectID,
	})
	if err != nil {
		return pgtype.UUID{}, errors.Wrapf(err, "create run chat session run_id=%s", uuidToString(runID))
	}
	// Ordinary chat endpoints only serve explicitly created or non-empty
	// sessions; this one is empty until its first follow-up is sent.
	if _, err := qtx.MarkChatSessionExplicitlyCreated(ctx, session.ID); err != nil {
		return pgtype.UUID{}, errors.Wrapf(err, "mark run chat session chat_session_id=%s", uuidToString(session.ID))
	}
	if service.IsTerminalTaskStatus(task.Status) {
		resumeTask, err := runChatResumeTask(ctx, qtx, runID, task)
		if err != nil {
			return pgtype.UUID{}, err
		}
		if err := qtx.UpdateChatSessionSession(ctx, service.RunChatResumePointer(session.ID, resumeTask)); err != nil {
			return pgtype.UUID{}, errors.Wrapf(err, "prefill run chat session chat_session_id=%s", uuidToString(session.ID))
		}
	}
	if err := qtx.SetAutopilotRunChatSession(ctx, db.SetAutopilotRunChatSessionParams{ID: runID, ChatSessionID: session.ID}); err != nil {
		return pgtype.UUID{}, errors.Wrapf(err, "link run chat session run_id=%s", uuidToString(runID))
	}

	if err := tx.Commit(ctx); err != nil {
		return pgtype.UUID{}, errors.Wrap(err, "commit run chat create")
	}

	return session.ID, nil
}

// runChatResumeTask picks the task a settled run's chat continues: the run's
// newest settled task that recorded a provider session — the auto-retry child
// when the run task was retried — or the run task itself when none did.
func runChatResumeTask(ctx context.Context, qtx *db.Queries, runID pgtype.UUID, runTask db.AgentTaskQueue) (db.AgentTaskQueue, error) {
	latest, err := qtx.GetLatestSettledAutopilotRunTaskWithSession(ctx, runID)
	if isNotFound(err) {
		return runTask, nil
	}
	if err != nil {
		return db.AgentTaskQueue{}, errors.Wrapf(err, "get run resume task run_id=%s", uuidToString(runID))
	}

	return latest, nil
}

// lockRunChatProject takes the project lock chat session creation requires.
// Project references are soft, so a deleted project leaves the session
// without one instead of failing the follow-up.
func lockRunChatProject(ctx context.Context, qtx *db.Queries, autopilot db.Autopilot) (pgtype.UUID, error) {
	if !autopilot.ProjectID.Valid {
		return pgtype.UUID{}, nil
	}

	_, err := qtx.LockProjectForChatSessionCreate(ctx, db.LockProjectForChatSessionCreateParams{
		ID:          autopilot.ProjectID,
		WorkspaceID: autopilot.WorkspaceID,
	})
	if isNotFound(err) {
		return pgtype.UUID{}, nil
	}
	if err != nil {
		return pgtype.UUID{}, errors.Wrapf(err, "lock project project_id=%s", uuidToString(autopilot.ProjectID))
	}

	return autopilot.ProjectID, nil
}

func (h *Handler) writeAutopilotRunChatError(w http.ResponseWriter, r *http.Request, err error) {
	slog.Error("autopilot run chat request failed", append(logger.RequestAttrs(r), "error", fmt.Sprintf("%+v", err))...)
	writeError(w, http.StatusInternalServerError, "internal error")
}
