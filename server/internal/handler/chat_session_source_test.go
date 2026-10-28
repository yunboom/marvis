package handler

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/yunboom/marvis/server/internal/testutil"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
	"github.com/yunboom/marvis/server/pkg/protocol"
)

// chatSessionSources lists every chat_session.source value.
var chatSessionSources = []string{
	protocol.ChatSessionSourceChat,
	protocol.ChatSessionSourceKbJob,
	protocol.ChatSessionSourceAutopilotRun,
	protocol.ChatSessionSourceKbBuilder,
	protocol.ChatSessionSourceAgentBuilder,
}

// assertChatSessionSource checks the stored source of a session.
func assertChatSessionSource(t *testing.T, sessionID, want string) {
	t.Helper()

	var got string
	dbfx.QueryRow(t, `SELECT source FROM chat_session WHERE id = $1`, sessionID).Scan(&got)
	if got != want {
		t.Fatalf("chat_session %s source = %q, want %q", sessionID, got, want)
	}
}

// seedSessionPerSource creates, for agentID, one session of every source,
// each holding a visible message and an in-flight task. The chat session
// also ends with a hidden instruction. It returns session ids by source.
func seedSessionPerSource(t *testing.T, agentID string, base time.Time) map[string]string {
	t.Helper()

	sessions := make(map[string]string, len(chatSessionSources))
	for _, source := range chatSessionSources {
		sessionID := dbfx.ChatSession(t, agentID, testutil.Cols{"title": source, "source": source})
		insertChatMessageRole(t, sessionID, "user", "visible "+source, protocol.ChatMessageKindMessage, false, base)
		insertPendingChatTask(t, agentID, sessionID, "queued")
		sessions[source] = sessionID
	}
	insertChatMessageRole(t, sessions[protocol.ChatSessionSourceChat], "user", "hidden instruction",
		protocol.ChatMessageKindInstruction, false, base.Add(time.Second))

	return sessions
}

// sessionIDSet collects the listed ids that belong to the seeded sessions.
func sessionIDSet(seeded map[string]string, ids []pgtype.UUID) map[string]bool {
	mine := make(map[string]bool, len(seeded))
	for _, id := range seeded {
		mine[id] = true
	}

	got := make(map[string]bool)
	for _, id := range ids {
		if s := uuidToString(id); mine[s] {
			got[s] = true
		}
	}

	return got
}

// assertOnlyChatListed fails unless the chat session is the only seeded
// session among ids.
func assertOnlyChatListed(t *testing.T, surface string, seeded map[string]string, ids []pgtype.UUID) {
	t.Helper()

	got := sessionIDSet(seeded, ids)
	if len(got) != 1 || !got[seeded[protocol.ChatSessionSourceChat]] {
		t.Errorf("%s lists %v, want only the chat session %s", surface, got, seeded[protocol.ChatSessionSourceChat])
	}
}

// TestChatSurfacesListOnlyChatSource seeds one session per source under a
// user agent, so only chat_session.source decides what chat surfaces show.
func TestChatSurfacesListOnlyChatSource(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	suffix := time.Now().UnixNano()
	agentID := dbfx.Agent(t, fmt.Sprintf("source-agent-%d", suffix), testRuntimeID)
	seeded := seedSessionPerSource(t, agentID, time.Now().Add(-time.Minute))

	active, err := testHandler.Queries.ListChatSessionsByCreator(ctx, db.ListChatSessionsByCreatorParams{
		WorkspaceID: parseUUID(testWorkspaceID), CreatorID: parseUUID(testUserID), Source: protocol.ChatSessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]pgtype.UUID, 0, len(active))
	for _, row := range active {
		ids = append(ids, row.ID)
	}
	assertOnlyChatListed(t, "ListChatSessionsByCreator", seeded, ids)

	all, err := testHandler.Queries.ListAllChatSessionsByCreator(ctx, db.ListAllChatSessionsByCreatorParams{
		WorkspaceID: parseUUID(testWorkspaceID), CreatorID: parseUUID(testUserID), Source: protocol.ChatSessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	ids = ids[:0]
	for _, row := range all {
		ids = append(ids, row.ID)
	}
	assertOnlyChatListed(t, "ListAllChatSessionsByCreator", seeded, ids)

	pending, err := testHandler.Queries.ListPendingChatTasksByCreator(ctx, db.ListPendingChatTasksByCreatorParams{
		WorkspaceID: parseUUID(testWorkspaceID), CreatorID: parseUUID(testUserID), Source: protocol.ChatSessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	ids = ids[:0]
	for _, row := range pending {
		ids = append(ids, row.ChatSessionID)
	}
	assertOnlyChatListed(t, "ListPendingChatTasksByCreator", seeded, ids)

	workspace, err := testHandler.Queries.ListKbWorkspaceChatSessions(ctx, db.ListKbWorkspaceChatSessionsParams{
		WorkspaceID: parseUUID(testWorkspaceID), Source: protocol.ChatSessionSourceChat,
		AgentID: parseUUID(agentID), RowLimit: chatListMaxLimit,
	})
	if err != nil {
		t.Fatal(err)
	}
	ids = ids[:0]
	for _, row := range workspace {
		ids = append(ids, row.ID)
	}
	assertOnlyChatListed(t, "ListKbWorkspaceChatSessions", seeded, ids)

	// The workspace list previews what the member saw, not the hidden instruction.
	if len(workspace) == 1 && workspace[0].LastMessageContent != "visible "+protocol.ChatSessionSourceChat {
		t.Errorf("workspace chat preview = %q, want the visible message", workspace[0].LastMessageContent)
	}
}

// TestHasPendingChatTasksIgnoresNonChatSources: a running knowledge base job,
// run follow-up or builder turn does not light the chat running indicator.
func TestHasPendingChatTasksIgnoresNonChatSources(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	suffix := time.Now().UnixNano()
	agentID := dbfx.Agent(t, fmt.Sprintf("source-pending-agent-%d", suffix), testRuntimeID)
	hasPending := func() bool {
		t.Helper()

		got, err := testHandler.Queries.HasPendingChatTasksByCreator(ctx, db.HasPendingChatTasksByCreatorParams{
			WorkspaceID: parseUUID(testWorkspaceID), CreatorID: parseUUID(testUserID),
			AgentIds: []pgtype.UUID{parseUUID(agentID)}, Source: protocol.ChatSessionSourceChat,
		})
		if err != nil {
			t.Fatal(err)
		}

		return got
	}

	for _, source := range chatSessionSources[1:] {
		sessionID := dbfx.ChatSession(t, agentID, testutil.Cols{"title": source, "source": source})
		insertPendingChatTask(t, agentID, sessionID, "running")
	}
	if hasPending() {
		t.Fatal("non-chat sessions with running tasks light the chat running indicator")
	}

	chatID := dbfx.ChatSession(t, agentID, testutil.Cols{"title": "chat", "source": protocol.ChatSessionSourceChat})
	insertPendingChatTask(t, agentID, chatID, "running")
	if !hasPending() {
		t.Fatal("a running chat turn does not light the chat running indicator")
	}
}

// TestListKbSourcesChatSources: ordinary chats and run follow-up chats are
// ingestible; a job's own chat and builder conversations are not.
func TestListKbSourcesChatSources(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	suffix := time.Now().UnixNano()
	since := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	slug := fmt.Sprintf("source-kinds-%d", suffix)
	insertTestKbBase(t, "Source kinds KB", slug)
	agentID := dbfx.Agent(t, fmt.Sprintf("source-kb-agent-%d", suffix), testRuntimeID)
	seeded := seedSessionPerSource(t, agentID, time.Now().Add(-time.Minute))

	var got []KbSource
	path := "/api/kb/sources?kb=" + slug + "&kinds=chat&limit=200&since=" + url.QueryEscape(since)
	testutil.Call(t, testHandler.ListKbSources, withMemberCtx(t, newRequest(http.MethodGet, path, nil))).
		Want(http.StatusOK).JSON(&got)
	listed := make(map[string]bool, len(got))
	for _, s := range got {
		listed[s.URI] = true
	}

	ingestible := map[string]bool{protocol.ChatSessionSourceChat: true, protocol.ChatSessionSourceAutopilotRun: true}
	for source, sessionID := range seeded {
		if listed["chat://"+sessionID] != ingestible[source] {
			t.Errorf("source %s listed = %t, want %t", source, listed["chat://"+sessionID], ingestible[source])
		}
	}
}

// TestCreateChatSessionSetsChatSource: a session created from the chat window
// is an ordinary chat.
func TestCreateChatSessionSetsChatSource(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	agentID := dbfx.Agent(t, fmt.Sprintf("source-create-agent-%d", time.Now().UnixNano()), testRuntimeID)
	var created ChatSessionResponse
	req := withMemberCtx(t, newRequest(http.MethodPost, "/api/chat/sessions", map[string]any{
		"agent_id": agentID, "title": "source",
	}))
	testutil.Call(t, testHandler.CreateChatSession, req).Want(http.StatusCreated).JSON(&created)
	dbfx.Cleanup(t, `DELETE FROM chat_session WHERE id = $1`, created.ID)

	assertChatSessionSource(t, created.ID, protocol.ChatSessionSourceChat)
}
