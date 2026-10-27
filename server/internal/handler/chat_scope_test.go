package handler

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/yunboom/marvis/server/internal/middleware"
	"github.com/yunboom/marvis/server/internal/testutil"
	"github.com/yunboom/marvis/server/internal/util"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// withMemberCtx sets the workspace member context the auth middleware sets
// for a request of userID.
func withMemberCtx(t *testing.T, req *http.Request) *http.Request {
	t.Helper()

	row, err := testHandler.Queries.GetMemberByUserAndWorkspace(context.Background(), db.GetMemberByUserAndWorkspaceParams{
		UserID:      util.MustParseUUID(req.Header.Get("X-User-ID")),
		WorkspaceID: util.MustParseUUID(testWorkspaceID),
	})
	if err != nil {
		t.Fatalf("load member row: %v", err)
	}

	return req.WithContext(middleware.SetMemberContext(req.Context(), testWorkspaceID, row))
}

func TestChatWorkspaceScope(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	suffix := time.Now().UnixNano()
	member := createPlainMember(t, fmt.Sprintf("chat-scope-%d@marvis.ai", suffix))
	agentID := dbfx.Agent(t, fmt.Sprintf("chat-scope-agent-%d", suffix), testRuntimeID)
	session := dbfx.ChatSession(t, agentID, testutil.Cols{"creator_id": member, "title": "member chat"})
	dbfx.InsertNoID(t, "chat_message", testutil.Cols{"chat_session_id": session, "role": "user", "content": "hello"},
		"chat_session_id = $1", session)

	list := func(req *http.Request, want int) []ChatSessionResponse {
		var got []ChatSessionResponse
		rec := testutil.Call(t, testHandler.ListChatSessions, withMemberCtx(t, req)).Want(want)
		if want == http.StatusOK {
			rec.JSON(&got)
		}

		return got
	}
	has := func(sessions []ChatSessionResponse) bool {
		for _, s := range sessions {
			if s.ID == session {
				return true
			}
		}

		return false
	}

	if has(list(newRequest(http.MethodGet, "/api/chat/sessions", nil), http.StatusOK)) {
		t.Error("the default scope lists another member's chat")
	}
	if !has(list(newRequest(http.MethodGet, "/api/chat/sessions?scope=workspace", nil), http.StatusOK)) {
		t.Error("an owner's scope=workspace list misses the member's chat")
	}
	since := sinceParam(time.Now().Add(time.Hour))
	if has(list(newRequest(http.MethodGet, "/api/chat/sessions?scope=workspace&since="+since, nil), http.StatusOK)) {
		t.Error("since does not filter")
	}
	list(newRequestAs(member, http.MethodGet, "/api/chat/sessions?scope=workspace", nil), http.StatusForbidden)
	list(newRequest(http.MethodGet, "/api/chat/sessions?scope=all", nil), http.StatusBadRequest)

	asAgent := func(agent string) *http.Request {
		task := dbfx.Task(t, agent, testutil.Cols{"runtime_id": testRuntimeID})
		req := newRequest(http.MethodGet, "/api/chat/sessions?scope=workspace", nil)
		req.Header.Set("X-Actor-Source", "task_token")
		req.Header.Set("X-Agent-ID", agent)
		req.Header.Set("X-Task-ID", task)

		return req
	}
	if !has(list(asAgent(agentID), http.StatusOK)) {
		t.Error("the owner's private agent cannot read the member's chat")
	}
	publicAgent := dbfx.Agent(t, fmt.Sprintf("chat-scope-public-%d", suffix), testRuntimeID, testutil.Cols{"permission_mode": "public_to", "visibility": "workspace"})
	list(asAgent(publicAgent), http.StatusForbidden)

	page := func(req *http.Request, want int) ChatMessagesPageResponse {
		var got ChatMessagesPageResponse
		rec := testutil.Call(t, testHandler.ListChatMessagesPage, withMemberCtx(t, testutil.WithURLParams(req, "sessionId", session))).Want(want)
		if want == http.StatusOK {
			rec.JSON(&got)
		}

		return got
	}
	page(newRequest(http.MethodGet, "/api/chat/sessions/x/messages/page", nil), http.StatusForbidden)
	if got := page(newRequest(http.MethodGet, "/api/chat/sessions/x/messages/page?scope=workspace", nil), http.StatusOK); len(got.Messages) != 1 {
		t.Errorf("scoped read = %+v", got)
	}
	if got := page(newRequest(http.MethodGet, "/api/chat/sessions/x/messages/page?scope=workspace&since="+since, nil), http.StatusOK); len(got.Messages) != 0 || got.HasMore {
		t.Errorf("scoped read since = %+v", got)
	}
	page(newRequestAs(member, http.MethodGet, "/api/chat/sessions/x/messages/page?scope=workspace", nil), http.StatusForbidden)
}

func sinceParam(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05Z")
}
