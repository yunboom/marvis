package main

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/yunboom/marvis/server/internal/realtime"
	"github.com/yunboom/marvis/server/internal/util"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// scopeAuthQuerier is the narrow subset of db.Queries used by the scope
// authorizer. Declared as an interface so the authorizer can be unit tested
// with an in-memory fake (no DB required).
type scopeAuthQuerier interface {
	GetAgentTask(ctx context.Context, id pgtype.UUID) (db.AgentTaskQueue, error)
	GetIssue(ctx context.Context, id pgtype.UUID) (db.Issue, error)
	GetChatSession(ctx context.Context, id pgtype.UUID) (db.ChatSession, error)
	GetAutopilotByRunChatSession(ctx context.Context, arg db.GetAutopilotByRunChatSessionParams) (db.Autopilot, error)
}

// dbScopeAuthorizer implements realtime.ScopeAuthorizer for the per-task and
// per-chat scopes (workspace/user scopes are validated by the hub itself
// against the connection identity). It returns true only when the requested
// resource exists, belongs to the caller's workspace, and — for chat
// resources — was created by the caller, or is an autopilot run's follow-up
// chat, which every member who can view the autopilot shares (mirroring the
// HTTP chat access model).
type dbScopeAuthorizer struct{ q scopeAuthQuerier }

func newScopeAuthorizer(q scopeAuthQuerier) *dbScopeAuthorizer { return &dbScopeAuthorizer{q: q} }

// scopeLookupErr converts a scope-resource query error into an authorizer
// result. A missing resource (pgx.ErrNoRows) is a legitimate denial — the
// HTTP layer treats not-found as 404 rather than 403, so the realtime layer
// reports it as a plain "forbidden" refusal. Any other error (pool
// exhaustion, a cancelled context, a network blip) is a transient lookup
// failure and must propagate so handleSubscribe reports "lookup_failed"
// instead of masking a database outage as a wave of permission denials.
func scopeLookupErr(err error) (bool, error) {
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return false, err
}

func (a *dbScopeAuthorizer) AuthorizeScope(ctx context.Context, userID, workspaceID, scopeType, scopeID string) (bool, error) {
	if workspaceID == "" || scopeID == "" {
		return false, nil
	}
	wsUUID, err := util.ParseUUID(workspaceID)
	if err != nil {
		return false, nil
	}
	idUUID, err := util.ParseUUID(scopeID)
	if err != nil {
		return false, nil
	}
	switch scopeType {
	case realtime.ScopeTask:
		task, err := a.q.GetAgentTask(ctx, idUUID)
		if err != nil {
			return scopeLookupErr(err)
		}
		// Issue tasks: visible to any workspace member.
		if task.IssueID.Valid {
			issue, err := a.q.GetIssue(ctx, task.IssueID)
			if err != nil {
				return scopeLookupErr(err)
			}
			return issue.WorkspaceID == wsUUID, nil
		}
		// Chat tasks: the same members as the task's chat session, mirroring
		// the HTTP layer's chat access.
		if task.ChatSessionID.Valid {
			sess, err := a.q.GetChatSession(ctx, task.ChatSessionID)
			if err != nil {
				return scopeLookupErr(err)
			}
			return a.chatSessionAllowed(ctx, sess, userID, wsUUID)
		}
		return false, nil
	case realtime.ScopeChat:
		sess, err := a.q.GetChatSession(ctx, idUUID)
		if err != nil {
			return scopeLookupErr(err)
		}
		return a.chatSessionAllowed(ctx, sess, userID, wsUUID)
	default:
		return false, nil
	}
}

// chatSessionAllowed mirrors the HTTP chat gate. Chat sessions are private to
// their creator (handler/chat.go loadChatSessionForUser), so a workspace
// member who learns a session_id cannot subscribe to chat:message / chat:done
// / chat:session_read for a peer's private chat. The one exception is an
// autopilot run's follow-up chat, shared by every member of its workspace.
func (a *dbScopeAuthorizer) chatSessionAllowed(ctx context.Context, sess db.ChatSession, userID string, wsUUID pgtype.UUID) (bool, error) {
	if sess.WorkspaceID != wsUUID {
		return false, nil
	}
	uidUUID, err := util.ParseUUID(userID)
	if err != nil {
		return false, nil
	}
	if sess.CreatorID == uidUUID {
		return true, nil
	}

	if _, err := a.q.GetAutopilotByRunChatSession(ctx, db.GetAutopilotByRunChatSessionParams{
		ChatSessionID: sess.ID,
		WorkspaceID:   wsUUID,
	}); err != nil {
		return scopeLookupErr(err)
	}

	return true, nil
}
