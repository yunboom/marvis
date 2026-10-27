package handler

import (
	"context"
	"net/http"

	"github.com/pkg/errors"

	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// canReadAutopilot reports whether the user may view the autopilot: today every
// member of its workspace may. GetAutopilot and the surfaces that share an
// autopilot's content with its viewers (run follow-up chats) all ask this one
// predicate, so narrowing who can view an autopilot narrows them together.
func (h *Handler) canReadAutopilot(ctx context.Context, ap db.Autopilot, userID string) (bool, error) {
	_, err := h.getWorkspaceMember(ctx, userID, uuidToString(ap.WorkspaceID))
	if isNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, errors.Wrapf(err, "load autopilot reader user_id=%s workspace_id=%s", userID, uuidToString(ap.WorkspaceID))
	}

	return true, nil
}

// runChatAccess resolves whether a member who did not create a chat session
// may still use it: an autopilot run's follow-up chat is shared by every
// member who can view the autopilot (canReadAutopilot). isRunChat is false for
// any other chat, which stays private to its creator.
func (h *Handler) runChatAccess(ctx context.Context, session db.ChatSession, userID string) (isRunChat, allowed bool, err error) {
	autopilot, err := h.Queries.GetAutopilotByRunChatSession(ctx, db.GetAutopilotByRunChatSessionParams{
		ChatSessionID: session.ID,
		WorkspaceID:   session.WorkspaceID,
	})
	if isNotFound(err) {
		return false, false, nil
	}
	if err != nil {
		return false, false, errors.Wrapf(err, "load run chat autopilot chat_session_id=%s", uuidToString(session.ID))
	}

	readable, err := h.canReadAutopilot(ctx, autopilot, userID)
	if err != nil {
		return true, false, err
	}

	return true, readable, nil
}

// authorizeChatSessionUser writes the refusal for a member who is not the
// session's creator and returns false, unless the session is a run follow-up
// chat they share. A run chat they cannot see answers 404, like a missing one.
func (h *Handler) authorizeChatSessionUser(w http.ResponseWriter, r *http.Request, session db.ChatSession, userID string) bool {
	if uuidToString(session.CreatorID) == userID {
		return true
	}

	isRunChat, allowed, err := h.runChatAccess(r.Context(), session, userID)
	if err != nil {
		h.writeAutopilotInternalError(w, r, err)
		return false
	}
	if !isRunChat {
		writeError(w, http.StatusForbidden, "not your chat session")
		return false
	}
	if !allowed {
		writeError(w, http.StatusNotFound, "chat session not found")
		return false
	}

	return true
}

// requireChatSessionCreator keeps a chat's organizing actions (rename, project,
// pin, archive, delete) with its creator even where other members share the
// conversation, since they change the chat for everyone.
func requireChatSessionCreator(w http.ResponseWriter, session db.ChatSession, userID string) bool {
	if uuidToString(session.CreatorID) == userID {
		return true
	}

	writeError(w, http.StatusForbidden, "only the chat creator can change this chat")

	return false
}
