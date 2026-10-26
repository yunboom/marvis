package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/kb"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/dbid"
)

// maxKbBuilderDraftBytes bounds one stored right-hand configuration. It is
// twice the agent builder's limit because a custom schema rides along (the
// default schema alone is about 8 KB); the limit only stops a client bug from
// growing an unbounded row.
const maxKbBuilderDraftBytes = 512 * 1024

// Builder conversation titles; the sessions never appear in chat lists.
const (
	kbBuilderCreateTitle = "Create a knowledge base"
	kbBuilderConfigTitle = "Configure %s"
)

// emptyKbBuilderDraft is the draft column of a session nobody has saved yet.
const emptyKbBuilderDraft = "{}"

// CreateKbBuilderSessionRequest opens a knowledge base builder conversation.
type CreateKbBuilderSessionRequest struct {
	Mode            string `json:"mode"`
	KnowledgeBaseID string `json:"knowledge_base_id"`
	SchemaMode      string `json:"schema_mode"`
	RuntimeID       string `json:"runtime_id"`
	Model           string `json:"model"`
}

// CreateKbBuilderSessionResponse names the new conversation and its carrier.
type CreateKbBuilderSessionResponse struct {
	SessionID      string `json:"session_id"`
	BuilderAgentID string `json:"builder_agent_id"`
	RuntimeID      string `json:"runtime_id"`
}

// KbBuilderSessionResponse is one unfinished builder conversation.
type KbBuilderSessionResponse struct {
	SessionID       string  `json:"session_id"`
	Mode            string  `json:"mode"`
	KnowledgeBaseID *string `json:"knowledge_base_id"`
	Title           string  `json:"title"`
	// RuntimeID is the carrier's runtime, where the next message runs.
	RuntimeID string `json:"runtime_id"`
	// LastMessageContent is the raw stored message in the builder wire format;
	// the client decodes it.
	LastMessageContent string  `json:"last_message_content"`
	LastMessageRole    string  `json:"last_message_role"`
	LastMessageAt      *string `json:"last_message_at"`
	// Draft is the saved right-hand configuration, opaque to the server; null
	// when never saved (the client replays the last <kb_draft> instead).
	Draft     json.RawMessage `json:"draft"`
	UpdatedAt string          `json:"updated_at"`
}

// SwitchKbBuilderRuntimeRequest re-points a builder conversation.
type SwitchKbBuilderRuntimeRequest struct {
	RuntimeID string `json:"runtime_id"`
}

// SwitchKbBuilderRuntimeResponse is the runtime that now answers.
type SwitchKbBuilderRuntimeResponse struct {
	SessionID string `json:"session_id"`
	RuntimeID string `json:"runtime_id"`
}

// SaveKbBuilderDraftRequest stores the right-hand configuration.
type SaveKbBuilderDraftRequest struct {
	Draft json.RawMessage `json:"draft"`
}

// canConfigureKb reports whether member may change a knowledge base's
// configuration: its creator, or a workspace owner or admin.
func canConfigureKb(member db.Member, base db.KbBase) bool {
	return isWorkspaceAdmin(member) || base.CreatedBy == member.UserID
}

// isKbBuilderCarrier reports whether an agent is a hidden knowledge base
// builder carrier.
func isKbBuilderCarrier(agent db.Agent) bool {
	return agent.Kind == "system" &&
		agent.SystemKey.Valid &&
		strings.HasPrefix(agent.SystemKey.String, kb.BuilderSystemKeyPrefix)
}

// CreateKbBuilderSession starts a private builder conversation: a hidden
// system agent carries it (the chat pipeline is agent-backed) and a
// kb_builder_session row records what it creates or configures. Messages go
// through the ordinary chat endpoints.
func (h *Handler) CreateKbBuilderSession(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req CreateKbBuilderSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	runtimeID := strings.TrimSpace(req.RuntimeID)
	if runtimeID == "" {
		writeError(w, http.StatusBadRequest, "runtime_id is required")
		return
	}
	if !kb.IsBuilderMode(req.Mode) {
		writeError(w, http.StatusBadRequest, "mode must be create or config")
		return
	}
	if req.SchemaMode != "" && !kb.IsSchemaMode(req.SchemaMode) {
		writeError(w, http.StatusBadRequest, "schema_mode must be default or custom")
		return
	}

	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}

	// What the conversation works on: nothing yet when creating, an existing
	// knowledge base the caller may configure otherwise.
	instructions := kb.BuilderInstructionsInput{Mode: req.Mode, SchemaMode: req.SchemaMode}
	title := kbBuilderCreateTitle
	var baseID pgtype.UUID
	if req.Mode == kb.BuilderModeCreate {
		if req.KnowledgeBaseID != "" {
			writeError(w, http.StatusBadRequest, "knowledge_base_id must be empty when creating")
			return
		}
		if instructions.SchemaMode == "" {
			instructions.SchemaMode = kb.SchemaModeDefault
		}
	} else {
		if req.KnowledgeBaseID == "" {
			writeError(w, http.StatusBadRequest, "knowledge_base_id is required when configuring")
			return
		}
		base, ok := h.loadKbBaseForUser(w, r, req.KnowledgeBaseID)
		if !ok {
			return
		}
		member, ok := h.workspaceMember(w, r, workspaceID)
		if !ok {
			return
		}
		if !canConfigureKb(member, base) {
			writeError(w, http.StatusForbidden, "only the knowledge base creator or a workspace owner or admin can configure it")
			return
		}
		baseID = base.ID
		instructions.Slug = base.Slug
		if instructions.SchemaMode == "" {
			instructions.SchemaMode = base.SchemaMode
		}
		title = fmt.Sprintf(kbBuilderConfigTitle, base.Name)
	}

	prompt, err := kb.BuilderInstructions(instructions)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}
	runtime, ok := h.resolveBuilderRuntime(w, r, workspaceID, workspaceUUID, runtimeID, "start")
	if !ok {
		return
	}

	flowID := uuid.NewString()
	ownerUUID := parseUUID(userID)
	model := strings.TrimSpace(req.Model)

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrap(err, "begin knowledge base builder session"))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	qtx := h.Queries.WithTx(tx)

	// Same lock protocol as CreateAgentBuilderSession: the workspace row keeps
	// a session from landing in a workspace mid-delete, and the runtime lock
	// keeps a privacy change from slipping between authorization and binding.
	if _, err := qtx.LockWorkspaceForChatSessionCreate(r.Context(), workspaceUUID); err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "lock workspace workspace_id=%s", workspaceID))
		return
	}
	runtime, err = qtx.LockAgentRuntimeForAccessChange(r.Context(), runtime.ID)
	if err != nil || runtime.WorkspaceID != workspaceUUID {
		writeError(w, http.StatusBadRequest, "invalid runtime_id")
		return
	}
	if !h.authorizeBuilderRuntime(w, r, workspaceID, runtime, "start") {
		return
	}

	builder, err := qtx.CreateAgentBuilder(r.Context(), db.CreateAgentBuilderParams{
		WorkspaceID:  workspaceUUID,
		Name:         ".marvis-kb-builder-" + flowID,
		RuntimeMode:  runtime.RuntimeMode,
		RuntimeID:    runtime.ID,
		OwnerID:      ownerUUID,
		Instructions: prompt,
		Model:        pgtype.Text{String: model, Valid: model != ""},
		SystemKey:    pgtype.Text{String: kb.BuilderSystemKeyPrefix + flowID, Valid: true},
	})
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "create knowledge base builder agent flow_id=%s", flowID))
		return
	}

	session, err := qtx.CreateChatSession(r.Context(), db.CreateChatSessionParams{
		ID:          dbid.NewV7(),
		WorkspaceID: workspaceUUID,
		AgentID:     builder.ID,
		CreatorID:   ownerUUID,
		Title:       title,
	})
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "create knowledge base builder chat flow_id=%s", flowID))
		return
	}
	session, err = qtx.MarkChatSessionExplicitlyCreated(r.Context(), session.ID)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "mark knowledge base builder chat flow_id=%s", flowID))
		return
	}

	if _, err := qtx.CreateKbBuilderSession(r.Context(), db.CreateKbBuilderSessionParams{
		ChatSessionID:   session.ID,
		WorkspaceID:     workspaceUUID,
		Mode:            req.Mode,
		KnowledgeBaseID: baseID,
	}); err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "create knowledge base builder session flow_id=%s", flowID))
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		h.writeKbInternalError(w, r, errors.Wrap(err, "commit knowledge base builder session"))
		return
	}

	writeJSON(w, http.StatusCreated, CreateKbBuilderSessionResponse{
		SessionID:      uuidToString(session.ID),
		BuilderAgentID: uuidToString(builder.ID),
		RuntimeID:      uuidToString(runtime.ID),
	})
}

// ListKbBuilderSessions returns the caller's unfinished builder
// conversations, newest activity first. They are hidden from every chat list,
// so this is the only way back to one; like every chat read it is
// creator-scoped.
func (h *Handler) ListKbBuilderSessions(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}

	params := db.ListKbBuilderSessionsByCreatorParams{
		WorkspaceID: workspaceUUID,
		CreatorID:   parseUUID(userID),
	}
	if mode := r.URL.Query().Get("mode"); mode != "" {
		if !kb.IsBuilderMode(mode) {
			writeError(w, http.StatusBadRequest, "mode must be create or config")
			return
		}
		params.Mode = pgtype.Text{String: mode, Valid: true}
	}
	if ref := r.URL.Query().Get("kb"); ref != "" {
		base, ok := h.loadKbBaseForUser(w, r, ref)
		if !ok {
			return
		}
		params.KnowledgeBaseID = base.ID
	}

	rows, err := h.Queries.ListKbBuilderSessionsByCreator(r.Context(), params)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "list knowledge base builder sessions workspace_id=%s", workspaceID))
		return
	}

	resp := make([]KbBuilderSessionResponse, len(rows))
	for i, row := range rows {
		var draft json.RawMessage
		if string(row.Draft) != emptyKbBuilderDraft {
			draft = row.Draft
		}
		resp[i] = KbBuilderSessionResponse{
			SessionID:          uuidToString(row.ID),
			Mode:               row.Mode,
			KnowledgeBaseID:    uuidToPtr(row.KnowledgeBaseID),
			Title:              row.Title,
			RuntimeID:          uuidToString(row.RuntimeID),
			LastMessageContent: row.LastMessageContent,
			LastMessageRole:    row.LastMessageRole,
			LastMessageAt:      timestampToPtr(row.LastMessageAt),
			Draft:              draft,
			UpdatedAt:          timestampToString(row.UpdatedAt),
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

// loadKbBuilderSessionForUser resolves a builder conversation the caller
// started. A chat session that is not a knowledge base builder conversation
// is reported as not found.
func (h *Handler) loadKbBuilderSessionForUser(w http.ResponseWriter, r *http.Request, userID string) (db.ChatSession, bool) {
	session, ok := h.loadChatSessionForUser(w, r, userID, h.resolveWorkspaceID(r), chi.URLParam(r, "sessionId"))
	if !ok {
		return db.ChatSession{}, false
	}

	if _, err := h.Queries.GetKbBuilderSession(r.Context(), session.ID); err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "knowledge base builder session not found")
			return db.ChatSession{}, false
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load knowledge base builder session session_id=%s", uuidToString(session.ID)))
		return db.ChatSession{}, false
	}

	return session, true
}

// SwitchKbBuilderRuntime re-points a builder conversation at another runtime
// (same rules as SwitchAgentBuilderRuntime).
func (h *Handler) SwitchKbBuilderRuntime(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req SwitchKbBuilderRuntimeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	runtimeID := strings.TrimSpace(req.RuntimeID)
	if runtimeID == "" {
		writeError(w, http.StatusBadRequest, "runtime_id is required")
		return
	}

	session, ok := h.loadKbBuilderSessionForUser(w, r, userID)
	if !ok {
		return
	}
	if session.Status != "active" {
		writeError(w, http.StatusBadRequest, "chat session is archived")
		return
	}
	agent, err := h.Queries.GetAgent(r.Context(), session.AgentID)
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load builder agent session_id=%s", uuidToString(session.ID)))
		return
	}
	if !isKbBuilderCarrier(agent) {
		writeError(w, http.StatusNotFound, "knowledge base builder session not found")
		return
	}

	updated, ok := h.rebindBuilderCarrier(w, r, h.resolveWorkspaceID(r), session, agent, runtimeID)
	if !ok {
		return
	}

	writeJSON(w, http.StatusOK, SwitchKbBuilderRuntimeResponse{
		SessionID: uuidToString(session.ID),
		RuntimeID: uuidToString(updated.RuntimeID),
	})
}

// SaveKbBuilderDraft stores the right-hand configuration of a builder
// conversation, including edits not yet sent. The payload is opaque to the
// server. The write runs under LockChatSessionForDraftWrite, the row lock the
// delete path takes, so a discard and a save cannot interleave (see
// SaveAgentBuilderDraft).
func (h *Handler) SaveKbBuilderDraft(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req SaveKbBuilderDraftRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Draft) == 0 || string(req.Draft) == "null" {
		writeError(w, http.StatusBadRequest, "draft is required")
		return
	}
	if len(req.Draft) > maxKbBuilderDraftBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "draft is too large")
		return
	}

	session, ok := h.loadKbBuilderSessionForUser(w, r, userID)
	if !ok {
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrap(err, "begin knowledge base builder draft save"))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	qtx := h.Queries.WithTx(tx)

	locked, err := qtx.LockChatSessionForDraftWrite(r.Context(), session.ID)
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "knowledge base builder session not found")
			return
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "lock chat session session_id=%s", uuidToString(session.ID)))
		return
	}
	if locked.Status != "active" {
		writeError(w, http.StatusBadRequest, "chat session is archived")
		return
	}

	if _, err := qtx.UpdateKbBuilderDraft(r.Context(), db.UpdateKbBuilderDraftParams{
		ChatSessionID: locked.ID,
		Draft:         req.Draft,
	}); err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "knowledge base builder session not found")
			return
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "save knowledge base builder draft session_id=%s", uuidToString(locked.ID)))
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		h.writeKbInternalError(w, r, errors.Wrap(err, "commit knowledge base builder draft"))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// DeleteKbBuilderSession discards a builder conversation: the chat session,
// its hidden carrier and the kb_builder_session row, through the ordinary
// chat delete.
func (h *Handler) DeleteKbBuilderSession(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	if _, ok := h.loadKbBuilderSessionForUser(w, r, userID); !ok {
		return
	}

	h.DeleteChatSession(w, r)
}
