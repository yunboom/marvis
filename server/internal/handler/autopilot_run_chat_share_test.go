package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/yunboom/marvis/server/internal/middleware"
	"github.com/yunboom/marvis/server/internal/testutil"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// sharedRunChatFixture is a settled run_only run on an online runtime whose
// agent every workspace member may invoke, with its follow-up chat created by
// the test user.
type sharedRunChatFixture struct {
	autopilotID   string
	chatSessionID string
}

func newSharedRunChatFixture(t *testing.T) sharedRunChatFixture {
	t.Helper()

	agentID, runtimeID, _ := createRuntimeGuardAgent(t, context.Background())
	dbfx.Cleanup(t, `DELETE FROM chat_session WHERE agent_id = $1`, agentID)
	dbfx.Exec(t, `UPDATE agent SET permission_mode = 'public_to' WHERE id = $1`, agentID)
	dbfx.Insert(t, "agent_invocation_target", testutil.Cols{
		"agent_id":    agentID,
		"target_type": "workspace",
		"target_id":   testWorkspaceID,
	})
	autopilotID := dbfx.Insert(t, "autopilot", testutil.Cols{
		"workspace_id":         testWorkspaceID,
		"title":                "shared run chat " + t.Name(),
		"assignee_id":          agentID,
		"assignee_type":        "agent",
		"execution_mode":       "run_only",
		"issue_title_template": "shared run chat",
		"status":               "active",
		"created_by_type":      "member",
		"created_by_id":        testUserID,
	})
	fx := runChatFixture{autopilotID: autopilotID, agentID: agentID, runtimeID: runtimeID}
	runID := fx.run(t, testutil.Cols{"status": "completed", "session_id": "shared-run-session"})

	var resp ensureRunChatResponse
	testutil.Call(t, testHandler.EnsureAutopilotRunChat, ensureRunChatRequest(testUserID, autopilotID, runID)).
		Want(http.StatusOK).JSON(&resp)

	return sharedRunChatFixture{autopilotID: autopilotID, chatSessionID: resp.ChatSessionID}
}

// chatRequestAs is a chat request by userID in the test workspace, with the
// member context the workspace middleware would attach.
func chatRequestAs(t *testing.T, userID, method, path string, body any, sessionID string) *http.Request {
	t.Helper()

	req := testutil.WithURLParams(newRequestAs(userID, method, path, body), "sessionId", sessionID)

	return withMemberCtx(t, req)
}

// outsiderChatRequest is a chat request by a user who is not a member of the
// test workspace; handler tests bypass the workspace middleware.
func outsiderChatRequest(userID, method, path string, body any, sessionID string) *http.Request {
	req := testutil.WithURLParams(newRequestAs(userID, method, path, body), "sessionId", sessionID)

	return req.WithContext(middleware.SetMemberContext(req.Context(), testWorkspaceID, db.Member{}))
}

func sendRunChatMessage(t *testing.T, userID, sessionID, content string) SendChatMessageResponse {
	t.Helper()

	var resp SendChatMessageResponse
	req := chatRequestAs(t, userID, "POST", "/api/chat/sessions/"+sessionID+"/messages", map[string]any{"content": content}, sessionID)
	testutil.Call(t, testHandler.SendChatMessage, req).Want(http.StatusCreated).JSON(&resp)

	return resp
}

func TestRunChat_SharedWithAutopilotViewers(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := newSharedRunChatFixture(t)
	peer := plainMember(t, "run-chat-peer")
	session := fx.chatSessionID
	messagesPath := "/api/chat/sessions/" + session + "/messages/page"

	peerSend := sendRunChatMessage(t, peer, session, "from the peer")
	creatorSend := sendRunChatMessage(t, testUserID, session, "from the creator")

	var initiator string
	dbfx.QueryRow(t, `SELECT initiator_user_id::text FROM agent_task_queue WHERE id = $1`, peerSend.TaskID).Scan(&initiator)
	if initiator != peer {
		t.Fatalf("peer follow-up initiator = %s, want the sender %s", initiator, peer)
	}

	// Settle the peer's turn so the creator's queued one is shown as current.
	dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'completed', completed_at = now() WHERE id = $1`, peerSend.TaskID)
	var page ChatMessagesPageResponse
	testutil.Call(t, testHandler.ListChatMessagesPage, chatRequestAs(t, peer, "GET", messagesPath, nil, session)).
		Want(http.StatusOK).JSON(&page)
	wantSender := map[string]string{peerSend.MessageID: peer, creatorSend.MessageID: testUserID}
	seen := 0
	for _, m := range page.Messages {
		want, ok := wantSender[m.ID]
		if !ok {
			continue
		}
		seen++
		if m.SenderUserID == nil || *m.SenderUserID != want {
			t.Fatalf("message %s sender = %v, want %s", m.ID, m.SenderUserID, want)
		}
	}
	if seen != len(wantSender) {
		t.Fatalf("peer saw %d of the %d sent messages: %+v", seen, len(wantSender), page.Messages)
	}

	testutil.Call(t, testHandler.GetChatSession, chatRequestAs(t, peer, "GET", "/api/chat/sessions/"+session, nil, session)).
		Want(http.StatusOK)

	// Organizing the chat stays with its creator.
	creatorOnly := []struct {
		name    string
		handler http.HandlerFunc
		method  string
		body    any
	}{
		{name: "rename", handler: testHandler.UpdateChatSession, method: "PATCH", body: map[string]any{"title": "renamed"}},
		{name: "pin", handler: testHandler.SetChatSessionPinned, method: "POST", body: map[string]any{"pinned": true}},
		{name: "archive", handler: testHandler.SetChatSessionArchived, method: "POST", body: map[string]any{"archived": true}},
		{name: "delete", handler: testHandler.DeleteChatSession, method: "DELETE"},
	}
	for _, tc := range creatorOnly {
		testutil.Call(t, tc.handler, chatRequestAs(t, peer, tc.method, "/api/chat/sessions/"+session, tc.body, session)).
			Want(http.StatusForbidden)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_session WHERE id = $1 AND status = 'active' AND pinned_at IS NULL`, session); n != 1 {
		t.Fatal("a peer changed the shared chat")
	}
}

func TestRunChat_HiddenFromMembersWhoCannotViewTheAutopilot(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := newSharedRunChatFixture(t)
	outsider := dbfx.User(t, "run-chat-outsider", "run-chat-outsider-"+t.Name()+"@marvis.test")
	session := fx.chatSessionID

	testutil.Call(t, testHandler.ListChatMessagesPage,
		outsiderChatRequest(outsider, "GET", "/api/chat/sessions/"+session+"/messages/page", nil, session)).
		Want(http.StatusNotFound)
	testutil.Call(t, testHandler.SendChatMessage,
		outsiderChatRequest(outsider, "POST", "/api/chat/sessions/"+session+"/messages", map[string]any{"content": "hi"}, session)).
		Want(http.StatusNotFound)
}

func TestRunChat_StaysOutOfChatSurfaces(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := newSharedRunChatFixture(t)
	sendRunChatMessage(t, testUserID, fx.chatSessionID, "follow-up")

	for _, path := range []string{"/api/chat/sessions", "/api/chat/sessions?status=all"} {
		var sessions []ChatSessionResponse
		testutil.Call(t, testHandler.ListChatSessions, withMemberCtx(t, newRequest("GET", path, nil))).
			Want(http.StatusOK).JSON(&sessions)
		for _, s := range sessions {
			if s.ID == fx.chatSessionID {
				t.Fatalf("%s lists the run's follow-up chat", path)
			}
		}
	}

	var pending PendingChatTasksResponse
	testutil.Call(t, testHandler.ListPendingChatTasks, withMemberCtx(t, newRequest("GET", "/api/chat/pending-tasks", nil))).
		Want(http.StatusOK).JSON(&pending)
	for _, task := range pending.Tasks {
		if task.ChatSessionID == fx.chatSessionID {
			t.Fatal("the chat running indicator counts the run's follow-up")
		}
	}
	var hasAny HasPendingChatTasksResponse
	testutil.Call(t, testHandler.HasPendingChatTasks, withMemberCtx(t, newRequest("GET", "/api/chat/pending-tasks/has-any", nil))).
		Want(http.StatusOK).JSON(&hasAny)
	if hasAny.HasPending && dbfx.Count(t, `
		SELECT count(*) FROM agent_task_queue t JOIN chat_session cs ON cs.id = t.chat_session_id
		WHERE cs.creator_id = $1 AND cs.workspace_id = $2 AND cs.id <> $3
		  AND t.status IN ('queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred')`,
		testUserID, testWorkspaceID, fx.chatSessionID) == 0 {
		t.Fatal("has-any reports the run's follow-up as pending chat work")
	}
}

func TestRunChat_DraftRestoresGoBackToTheirSender(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := newSharedRunChatFixture(t)
	peer := plainMember(t, "run-chat-restore-peer")
	session := fx.chatSessionID
	sent := sendRunChatMessage(t, peer, session, "stopped prompt")
	restoreID := dbfx.Insert(t, "chat_draft_restore", testutil.Cols{
		"id":              testutil.Raw("gen_random_uuid()"),
		"chat_session_id": session,
		"task_id":         sent.TaskID,
		"content":         "stopped prompt",
	})
	restoresPath := "/api/chat/sessions/" + session + "/draft-restores"

	var creatorView, peerView ChatDraftRestoresResponse
	testutil.Call(t, testHandler.ListChatDraftRestores, chatRequestAs(t, testUserID, "GET", restoresPath, nil, session)).
		Want(http.StatusOK).JSON(&creatorView)
	testutil.Call(t, testHandler.ListChatDraftRestores, chatRequestAs(t, peer, "GET", restoresPath, nil, session)).
		Want(http.StatusOK).JSON(&peerView)
	if len(creatorView.Restores) != 0 {
		t.Fatalf("the creator got another member's stopped prompt: %+v", creatorView.Restores)
	}
	if len(peerView.Restores) != 1 || peerView.Restores[0].ID != restoreID {
		t.Fatalf("peer restores = %+v, want their own %s", peerView.Restores, restoreID)
	}

	consume := testutil.WithURLParams(newRequestAs(testUserID, "DELETE", restoresPath+"/"+restoreID, nil), "sessionId", session, "restoreId", restoreID)
	testutil.Call(t, testHandler.ConsumeChatDraftRestore, withMemberCtx(t, consume)).Want(http.StatusNoContent)
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_draft_restore WHERE id = $1`, restoreID); n != 1 {
		t.Fatal("the creator consumed another member's stopped prompt")
	}
}

func TestDeleteAutopilot_ArchivesRunChats(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := newSharedRunChatFixture(t)

	req := withURLParam(newRequest("DELETE", "/api/autopilots/"+fx.autopilotID, nil), "id", fx.autopilotID)
	testutil.Call(t, testHandler.DeleteAutopilot, req).Want(http.StatusNoContent)

	var status string
	dbfx.QueryRow(t, `SELECT status FROM chat_session WHERE id = $1`, fx.chatSessionID).Scan(&status)
	if status != "archived" {
		t.Fatalf("run chat status = %q after deleting the autopilot, want archived", status)
	}
}

func TestEnsureAutopilotRunChat_ResumesTheLatestRetry(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := newRunChatFixture(t, "run_only")
	runID, _ := fx.runWithTask(t, testutil.Cols{
		"status":         "failed",
		"failure_reason": "timeout",
		"session_id":     "first-attempt-session",
		"work_dir":       "/tmp/run-chat-first-attempt",
		"runtime_id":     fx.runtimeID,
		"created_at":     testutil.Raw("now() - interval '1 minute'"),
	})
	dbfx.Task(t, fx.agentID, testutil.Cols{
		"status":           "completed",
		"autopilot_run_id": runID,
		"session_id":       "retry-session",
		"work_dir":         "/tmp/run-chat-retry",
		"runtime_id":       fx.runtimeID,
	})

	var resp ensureRunChatResponse
	testutil.Call(t, testHandler.EnsureAutopilotRunChat, ensureRunChatRequest(testUserID, fx.autopilotID, runID)).
		Want(http.StatusOK).JSON(&resp)

	var sessionID, workDir string
	dbfx.QueryRow(t, `SELECT session_id, work_dir FROM chat_session WHERE id = $1`, resp.ChatSessionID).Scan(&sessionID, &workDir)
	if sessionID != "retry-session" || workDir != "/tmp/run-chat-retry" {
		t.Fatalf("resume pointer = %q %q, want the retry's", sessionID, workDir)
	}
}
