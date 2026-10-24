package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/dbid"
)

// knowledgeSessionSystemKeyPrefix 标记知识库会话背后的隐藏执行 agent。
const knowledgeSessionSystemKeyPrefix = "kb_session:"

// 知识库会话的操作类型（与迁移 604 的约束一致）。
const (
	knowledgeSessionFix    = "fix"
	knowledgeSessionIngest = "ingest"
	knowledgeSessionFresh  = "fresh"
	knowledgeSessionMerge  = "merge"
	knowledgeSessionGap    = "gap"
	knowledgeSessionCreate = "create"
	knowledgeSessionRebase = "rebase"
)

var validKnowledgeSessionKinds = map[string]bool{
	knowledgeSessionFix: true, knowledgeSessionIngest: true, knowledgeSessionFresh: true, knowledgeSessionMerge: true,
	knowledgeSessionGap: true, knowledgeSessionCreate: true, knowledgeSessionRebase: true,
}

// knowledgeSessionInstructions 追加在维护智能体原有指令之后，约束它只通过变更请求改知识库。
const knowledgeSessionInstructions = `## Knowledge maintenance session

You are maintaining the workspace knowledge bases in a conversation with a person who watches your work.
The first message names the operation, the knowledge base(s) and this session's id.

- Work in a local clone: run "marvis kb clone" once, then "marvis kb sync" before editing.
- Follow <slug>/AGENTS.md of every knowledge base you touch. It is the schema; do not invent another layout.
- Never push to main. Submit with "marvis kb change create --dir <clone> --title ... --source <operation> --session <session id> --summary ... --risk low|medium|high",
  adding "--annotations <ids>" when you handle annotations. If the person asks for more changes, edit the same branch and run "marvis kb change update <number> --dir <clone>".
- Before submitting: run "marvis kb lint --dir <clone> --kb <slug>" and fix findings; remove secrets, tokens, passwords, phone numbers and ID numbers; write the summary as a self-review (what changed, why, what you did not change).
- Freshness: run "marvis kb lint" and "marvis kb stale"; record each real problem with "marvis kb annotate add" instead of editing.
- Merge conflicts reported by "change create" or "change update": run "marvis kb sync", resolve, then update the change request.
- Creating a knowledge base: do not touch the repository. Talk with the person, then end every reply with exactly one line
  <kb_draft>{"name":"","description":"","purpose":""}</kb_draft> holding compact JSON; the person confirms it in the app.
- Reply in the person's language. Keep replies short: what you did, the change request number, anything that needs a decision.`

// CreateKnowledgeSessionRequest 是发起知识库会话的请求体。
type CreateKnowledgeSessionRequest struct {
	Kind            string `json:"kind"`
	KnowledgeBaseID string `json:"knowledge_base_id"`
	AgentID         string `json:"agent_id"`
}

// CreateKnowledgeSessionResponse 返回会话 id；首条消息由客户端按用户语言组织后通过聊天接口发出。
type CreateKnowledgeSessionResponse struct {
	SessionID         string `json:"session_id"`
	CarrierAgentID    string `json:"carrier_agent_id"`
	MaintainerAgentID string `json:"maintainer_agent_id"`
	Kind              string `json:"kind"`
}

// CreateKnowledgeSession 为一次知识库操作创建隐藏会话（POST /api/knowledge/sessions）。
// 执行载体是沿用维护智能体运行时和模型的隐藏系统 agent，会话因此不会出现在「我的对话」里。
func (h *Handler) CreateKnowledgeSession(w http.ResponseWriter, r *http.Request) {
	if !h.requireKnowledgeStore(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	if isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "knowledge sessions are started by a person")
		return
	}
	var req CreateKnowledgeSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !validKnowledgeSessionKinds[req.Kind] {
		writeError(w, http.StatusBadRequest, "invalid kind")
		return
	}
	ctx := r.Context()
	wsUUID := parseUUID(workspaceID)

	var kb db.KnowledgeBase
	if req.Kind != knowledgeSessionCreate {
		id, err := parseUUIDLoose(req.KnowledgeBaseID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "knowledge_base_id is required")
			return
		}
		if kb, err = h.Queries.GetKnowledgeBase(ctx, db.GetKnowledgeBaseParams{ID: id, WorkspaceID: wsUUID}); err != nil {
			writeError(w, http.StatusNotFound, "knowledge base not found")
			return
		}
	}
	agentRef := strings.TrimSpace(req.AgentID)
	if agentRef == "" && kb.MaintainerAgentID.Valid {
		agentRef = uuidToString(kb.MaintainerAgentID)
	}
	if agentRef == "" {
		writeErrorCode(w, http.StatusConflict, "maintainer_required", "choose a maintainer agent first")
		return
	}
	maintainerID, ok := parseUUIDOrBadRequest(w, agentRef, "agent_id")
	if !ok {
		return
	}
	maintainer, err := h.Queries.GetAgent(ctx, maintainerID)
	if err != nil || maintainer.WorkspaceID != wsUUID || maintainer.ArchivedAt.Valid {
		writeError(w, http.StatusBadRequest, "maintainer agent not found in this workspace")
		return
	}
	if !maintainer.RuntimeID.Valid {
		writeError(w, http.StatusConflict, "maintainer agent has no runtime")
		return
	}
	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	if !h.canInvokeAgent(ctx, maintainer, actorType, actorID, h.invokeOriginatorFromRequest(r, actorType, actorID), workspaceID) {
		h.writeDispatchBlocked(w, http.StatusForbidden, ReasonInvocationNotAllowed)
		return
	}
	runtime, ok := h.resolveBuilderRuntime(w, r, workspaceID, wsUUID, uuidToString(maintainer.RuntimeID), "start")
	if !ok {
		return
	}

	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start knowledge session")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := h.Queries.WithTx(tx)
	if _, err := qtx.LockWorkspaceForChatSessionCreate(ctx, wsUUID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to lock workspace")
		return
	}
	runtime, err = qtx.LockAgentRuntimeForAccessChange(ctx, runtime.ID)
	if err != nil || runtime.WorkspaceID != wsUUID {
		writeError(w, http.StatusBadRequest, "maintainer runtime is not available")
		return
	}
	if !h.authorizeBuilderRuntime(w, r, workspaceID, runtime, "start") {
		return
	}

	flowID := uuid.NewString()
	instructions := knowledgeSessionInstructions
	if s := strings.TrimSpace(maintainer.Instructions); s != "" {
		instructions = s + "\n\n" + knowledgeSessionInstructions
	}
	carrier, err := qtx.CreateAgentBuilder(ctx, db.CreateAgentBuilderParams{
		WorkspaceID: wsUUID,
		// Agent names are unique per workspace; the session UI shows the maintainer's name.
		Name:         ".marvis-knowledge-" + flowID,
		RuntimeMode:  runtime.RuntimeMode,
		RuntimeID:    runtime.ID,
		OwnerID:      parseUUID(userID),
		Instructions: instructions,
		Model:        maintainer.Model,
		SystemKey:    pgtype.Text{String: knowledgeSessionSystemKeyPrefix + flowID, Valid: true},
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to prepare knowledge session")
		return
	}
	session, err := qtx.CreateChatSession(ctx, db.CreateChatSessionParams{
		ID:          dbid.NewV7(),
		WorkspaceID: wsUUID,
		AgentID:     carrier.ID,
		CreatorID:   parseUUID(userID),
		Title:       fmt.Sprintf("Knowledge %s", req.Kind),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create knowledge session")
		return
	}
	if _, err := qtx.MarkChatSessionExplicitlyCreated(ctx, session.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create knowledge session")
		return
	}
	if _, err := qtx.CreateKnowledgeSession(ctx, db.CreateKnowledgeSessionParams{
		ChatSessionID: session.ID, WorkspaceID: wsUUID, CarrierAgentID: carrier.ID, KnowledgeBaseID: kb.ID,
		Kind: req.Kind, CreatedBy: parseUUID(userID),
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to record knowledge session")
		return
	}
	// 第一次发起时选的智能体记为该知识库的维护智能体（已设置的不覆盖）。
	if kb.ID.Valid && !kb.MaintainerAgentID.Valid {
		if err := qtx.SetKnowledgeBaseMaintainerIfUnset(ctx, db.SetKnowledgeBaseMaintainerIfUnsetParams{ID: kb.ID, WorkspaceID: wsUUID, MaintainerAgentID: maintainer.ID}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to remember maintainer agent")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start knowledge session")
		return
	}

	if kb.ID.Valid {
		h.publishKnowledge(workspaceID, actorType, actorID, knowledgeEventBase, uuidToString(kb.ID))
	}
	writeJSON(w, http.StatusCreated, CreateKnowledgeSessionResponse{
		SessionID: uuidToString(session.ID), CarrierAgentID: uuidToString(carrier.ID),
		MaintainerAgentID: uuidToString(maintainer.ID), Kind: req.Kind,
	})
}

// KnowledgeSessionResponse 是会话的元信息，用于从变更请求回到会话。
type KnowledgeSessionResponse struct {
	SessionID       string  `json:"session_id"`
	Kind            string  `json:"kind"`
	KnowledgeBaseID *string `json:"knowledge_base_id"`
	CreatedBy       string  `json:"created_by"`
	CreatedAt       string  `json:"created_at"`
}

// GetKnowledgeSession 返回会话元信息（GET /api/knowledge/sessions/{sessionId}）。
func (h *Handler) GetKnowledgeSession(w http.ResponseWriter, r *http.Request) {
	if !h.requireKnowledgeStore(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "sessionId"), "session id")
	if !ok {
		return
	}
	s, err := h.Queries.GetKnowledgeSession(r.Context(), db.GetKnowledgeSessionParams{ChatSessionID: id, WorkspaceID: parseUUID(workspaceID)})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "knowledge session not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to load knowledge session")
		}
		return
	}

	writeJSON(w, http.StatusOK, KnowledgeSessionResponse{
		SessionID: uuidToString(s.ChatSessionID), Kind: s.Kind, KnowledgeBaseID: uuidToPtr(s.KnowledgeBaseID),
		CreatedBy: uuidToString(s.CreatedBy), CreatedAt: timestampToString(s.CreatedAt),
	})
}
