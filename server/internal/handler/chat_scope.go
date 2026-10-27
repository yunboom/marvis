package handler

import (
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/util"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// Chat read scopes (spec 8.7). Without scope=workspace the chat reads keep
// their creator-only rule.
const (
	chatScopeMine      = "mine"
	chatScopeWorkspace = "workspace"
)

// chatAgentPermissionPrivate is agent.permission_mode for an agent only its
// owner can invoke.
const chatAgentPermissionPrivate = "private"

// chatWorkspaceReadRole is the member role that may read every chat.
const chatWorkspaceReadRole = "owner"

// chatListDefaultLimit pages scope=workspace lists when no limit is given.
const chatListDefaultLimit = 50

// chatListMaxLimit caps a chat list page.
const chatListMaxLimit = 200

// chatWorkspaceReadAllowed decides whether the caller may read every member's
// chats (scope=workspace): an owner calling in person, or an agent whose
// permission mode is private and whose owner is a workspace owner. Every
// other caller reads only the chats it started.
func (h *Handler) chatWorkspaceReadAllowed(r *http.Request, userID, workspaceID string, member db.Member) (bool, error) {
	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	if actorType != kbActorAgent {
		return member.Role == chatWorkspaceReadRole, nil
	}

	agentID, err := util.ParseUUID(actorID)
	if err != nil {
		return false, nil
	}
	agent, err := h.Queries.GetAgent(r.Context(), agentID)
	if err != nil {
		if isNotFound(err) {
			return false, nil
		}

		return false, errors.Wrapf(err, "load agent agent_id=%s", actorID)
	}
	if agent.PermissionMode != chatAgentPermissionPrivate {
		return false, nil
	}

	owner, err := h.Queries.GetMemberByUserAndWorkspace(r.Context(), db.GetMemberByUserAndWorkspaceParams{
		UserID:      agent.OwnerID,
		WorkspaceID: agent.WorkspaceID,
	})
	if err != nil {
		if isNotFound(err) {
			return false, nil
		}

		return false, errors.Wrapf(err, "load agent owner agent_id=%s", actorID)
	}

	return owner.Role == chatWorkspaceReadRole, nil
}

// chatReadScope reads ?scope and, for workspace, checks the caller may use
// it. It writes the error response and returns ok=false when it fails.
func (h *Handler) chatReadScope(w http.ResponseWriter, r *http.Request, userID, workspaceID string, member db.Member) (string, bool) {
	scope := r.URL.Query().Get("scope")
	switch scope {
	case "", chatScopeMine:
		return chatScopeMine, true
	case chatScopeWorkspace:
	default:
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "scope must be mine or workspace")
		return "", false
	}

	allowed, err := h.chatWorkspaceReadAllowed(r, userID, workspaceID, member)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return "", false
	}
	if !allowed {
		writeErrorCode(w, http.StatusForbidden, kbCodeChatScopeDenied,
			"only a workspace owner, or an owner's private agent, can read every member's chats")
		return "", false
	}

	return chatScopeWorkspace, true
}

// chatListFilter holds the optional filters of a chat list read by the CLI.
type chatListFilter struct {
	since   pgtype.Timestamptz
	agentID pgtype.UUID
	limit   int
	offset  int
	// set reports that any filter was given; without one the mine list is
	// returned exactly as before.
	set bool
}

func parseChatListFilter(w http.ResponseWriter, r *http.Request) (chatListFilter, bool) {
	query := r.URL.Query()
	f := chatListFilter{limit: chatListDefaultLimit}

	if raw := query.Get("since"); raw != "" {
		t, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "since must be an RFC3339 time")
			return chatListFilter{}, false
		}
		f.since = pgtype.Timestamptz{Time: t, Valid: true}
		f.set = true
	}
	if raw := query.Get("agent_id"); raw != "" {
		id, ok := parseUUIDOrBadRequest(w, raw, "agent_id")
		if !ok {
			return chatListFilter{}, false
		}
		f.agentID = id
		f.set = true
	}
	for key, dst := range map[string]*int{"limit": &f.limit, "offset": &f.offset} {
		raw := query.Get(key)
		if raw == "" {
			continue
		}
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 || (key == "limit" && (n < 1 || n > chatListMaxLimit)) {
			writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "invalid "+key)
			return chatListFilter{}, false
		}
		*dst = n
		f.set = true
	}

	return f, true
}

// apply filters and pages a creator's chat list in memory.
func (f chatListFilter) apply(sessions []ChatSessionResponse) []ChatSessionResponse {
	if !f.set {
		return sessions
	}

	agentID := ""
	if f.agentID.Valid {
		agentID = uuidToString(f.agentID)
	}
	kept := make([]ChatSessionResponse, 0, len(sessions))
	for _, s := range sessions {
		if agentID != "" && s.AgentID != agentID {
			continue
		}
		if f.since.Valid && (s.LastMessage == nil || !chatLastMessageAfter(s.LastMessage, f.since.Time)) {
			continue
		}
		kept = append(kept, s)
	}

	if f.offset >= len(kept) {
		return []ChatSessionResponse{}
	}
	kept = kept[f.offset:]
	if len(kept) > f.limit {
		kept = kept[:f.limit]
	}

	return kept
}

func chatLastMessageAfter(m *ChatLastMessage, since time.Time) bool {
	at, err := time.Parse(time.RFC3339, m.CreatedAt)

	return err == nil && at.After(since)
}

// listWorkspaceChatSessions lists every member's public chats for an
// allowed scope=workspace read.
func (h *Handler) listWorkspaceChatSessions(w http.ResponseWriter, r *http.Request, workspaceID string, f chatListFilter) {
	rows, err := h.Queries.ListKbWorkspaceChatSessions(r.Context(), db.ListKbWorkspaceChatSessionsParams{
		WorkspaceID: parseUUID(workspaceID),
		Since:       f.since,
		AgentID:     f.agentID,
		RowLimit:    int32(f.limit),
		RowOffset:   int32(f.offset),
	})
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "list workspace chats workspace_id=%s", workspaceID))
		return
	}

	resp := make([]ChatSessionResponse, len(rows))
	for i, s := range rows {
		resp[i] = ChatSessionResponse{
			ID:          uuidToString(s.ID),
			WorkspaceID: uuidToString(s.WorkspaceID),
			AgentID:     uuidToString(s.AgentID),
			CreatorID:   uuidToString(s.CreatorID),
			ProjectID:   uuidToPtr(s.ProjectID),
			Title:       s.Title,
			Status:      s.Status,
			LastMessage: buildChatLastMessage(s.LastMessageAt, s.LastMessageContent, s.LastMessageRole, pgtype.Text{}, ""),
			Pinned:      s.PinnedAt.Valid,
			CreatedAt:   timestampToString(s.CreatedAt),
			UpdatedAt:   timestampToString(s.UpdatedAt),
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

// gateChatMessagesPageSession picks the session gate of a messages read: the
// creator gate by default, the workspace-wide read for an allowed
// scope=workspace.
func (h *Handler) gateChatMessagesPageSession(w http.ResponseWriter, r *http.Request, userID, workspaceID, sessionID string) (db.ChatSession, bool) {
	if r.URL.Query().Get("scope") == "" {
		return h.gatePublicChatSessionForUser(w, r, userID, workspaceID, sessionID)
	}

	member, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return db.ChatSession{}, false
	}
	scope, ok := h.chatReadScope(w, r, userID, workspaceID, member)
	if !ok {
		return db.ChatSession{}, false
	}
	if scope == chatScopeMine {
		return h.gatePublicChatSessionForUser(w, r, userID, workspaceID, sessionID)
	}

	return h.loadChatSessionForScopedRead(w, r, workspaceID, sessionID)
}

func parseChatSince(w http.ResponseWriter, r *http.Request) (pgtype.Timestamptz, bool) {
	raw := r.URL.Query().Get("since")
	if raw == "" {
		return pgtype.Timestamptz{}, true
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		writeErrorCode(w, http.StatusBadRequest, kbCodeInvalidRequest, "since must be an RFC3339 time")
		return pgtype.Timestamptz{}, false
	}

	return pgtype.Timestamptz{Time: t, Valid: true}, true
}

// chatMessagesSince keeps the messages after since from a newest-first page;
// cut reports that older messages were dropped, so no older page is needed.
func chatMessagesSince(messages []db.ChatMessage, since time.Time) ([]db.ChatMessage, bool) {
	kept := make([]db.ChatMessage, 0, len(messages))
	for _, m := range messages {
		if m.CreatedAt.Time.After(since) {
			kept = append(kept, m)
		}
	}

	return kept, len(kept) < len(messages)
}

// loadChatSessionForScopedRead loads a public chat of the workspace for a
// scope=workspace read, without the creator check.
func (h *Handler) loadChatSessionForScopedRead(w http.ResponseWriter, r *http.Request, workspaceID, sessionID string) (db.ChatSession, bool) {
	sessionUUID, ok := parseUUIDOrBadRequest(w, sessionID, "chat session id")
	if !ok {
		return db.ChatSession{}, false
	}
	session, err := h.Queries.GetPublicChatSessionInWorkspace(r.Context(), db.GetPublicChatSessionInWorkspaceParams{
		ID:          sessionUUID,
		WorkspaceID: parseUUID(workspaceID),
	})
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "chat session not found")
			return db.ChatSession{}, false
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load scoped chat session chat_session_id=%s", sessionID))
		return db.ChatSession{}, false
	}

	return session, true
}
