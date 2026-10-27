package handler

import (
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/testutil"
)

// TestListKbSources lists issues, comments, chats and raw files updated
// since a time, leaves out what a claim of the knowledge base already cites,
// and shows chats by the chat read rules.
func TestListKbSources(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	suffix := time.Now().UnixNano()
	since := time.Now().Add(-time.Second).UTC().Format(time.RFC3339)
	slug := fmt.Sprintf("sources-%d", suffix)
	base := insertTestKbBase(t, "Sources KB", slug)
	page := createTestKbPage(t, base, kb.NewPage{Slug: "p", Title: "P", Markdown: "Body."})

	issue := dbfx.Issue(t, fmt.Sprintf("Refund callback %d", suffix))
	var key string
	dbfx.QueryRow(t, `SELECT w.issue_prefix || '-' || i.number FROM issue i JOIN workspace w ON w.id = i.workspace_id WHERE i.id = $1`, issue).Scan(&key)
	comment := dbfx.Insert(t, "comment", testutil.Cols{
		"issue_id": issue, "workspace_id": testWorkspaceID, "author_type": "member", "author_id": testUserID, "content": "Root cause found.",
	})
	dbfx.Insert(t, "kb_raw", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "kind": kb.RawKindSource, "name": "spec.pdf",
		"storage_key": "k1", "size": 1, "content_type": "application/pdf", "uploaded_by": testUserID,
	})
	dbfx.Insert(t, "kb_raw", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "kind": kb.RawKindSource, "name": "notes.pdf",
		"storage_key": "k2", "size": 1, "content_type": "application/pdf", "uploaded_by": testUserID,
	})

	member := createPlainMember(t, fmt.Sprintf("kb-sources-%d@marvis.ai", suffix))
	agentID := dbfx.Agent(t, fmt.Sprintf("kb-sources-agent-%d", suffix), testRuntimeID)
	chatWith := func(creator string) string {
		session := dbfx.ChatSession(t, agentID, testutil.Cols{"creator_id": creator, "title": "chat"})
		dbfx.InsertNoID(t, "chat_message", testutil.Cols{"chat_session_id": session, "role": "user", "content": "hello"},
			"chat_session_id = $1", session)

		return session
	}
	memberChat := chatWith(member)
	ownerChat := chatWith(testUserID)

	// A claim cites the issue and one page of spec.pdf.
	var blockID string
	dbfx.QueryRow(t, `SELECT blocks->0->>'id' FROM kb_page WHERE id = $1`, page).Scan(&blockID)
	evidence := fmt.Sprintf(`[{"source":"t","uri":"task://%s","title":"t"},{"source":"s","uri":"raw://sources/spec.pdf#page=2","title":"s"}]`, key)
	dbfx.Insert(t, "kb_claim", testutil.Cols{
		"workspace_id": testWorkspaceID, "knowledge_base_id": base, "page_id": page, "block_id": blockID,
		"key": "c1", "text": "Body.", "evidence": evidence, "checked_at": time.Now(),
	})

	list := func(req *http.Request) map[string]KbSource {
		var got []KbSource
		testutil.Call(t, testHandler.ListKbSources, withMemberCtx(t, req)).Want(http.StatusOK).JSON(&got)
		byURI := make(map[string]KbSource, len(got))
		for _, s := range got {
			byURI[s.URI] = s
		}

		return byURI
	}
	path := "/api/kb/sources?kb=" + slug + "&limit=200&since=" + url.QueryEscape(since)
	taskURI := "task://" + key
	commentURI := taskURI + "#comment-" + comment

	got := list(newRequest(http.MethodGet, path, nil))
	if _, ok := got[taskURI]; ok {
		t.Error("an issue a claim cites is listed as not ingested")
	}
	if _, ok := got["raw://sources/spec.pdf"]; ok {
		t.Error("a raw file cited by page is listed as not ingested")
	}
	if s := got[commentURI]; s.Kind != kbSourceKindComment || s.ReadWith != "marvis issue comment list "+key {
		t.Errorf("comment = %+v", s)
	}
	if s := got["raw://sources/notes.pdf"]; s.Kind != kb.SourceKindRaw || s.ReadWith != "marvis kb raw get "+slug+" notes.pdf" {
		t.Errorf("raw = %+v", s)
	}
	if s := got["chat://"+memberChat]; s.Title != kb.SourceKindChat || s.ReadWith != "marvis chat get "+memberChat+" --scope workspace" {
		t.Errorf("an owner misses a member's chat: %+v", s)
	}

	all := list(newRequest(http.MethodGet, path+"&ingested=true&kinds=task", nil))
	if s := all[taskURI]; !s.Ingested || s.ReadWith != "marvis issue get "+key {
		t.Errorf("ingested=true issue = %+v", s)
	}
	if _, ok := all[commentURI]; ok {
		t.Error("kinds=task lists a comment")
	}

	asMember := list(newRequestAs(member, http.MethodGet, path+"&kinds=chat", nil))
	if _, ok := asMember["chat://"+ownerChat]; ok {
		t.Error("a member sees the owner's chat")
	}
	if s := asMember["chat://"+memberChat]; s.ReadWith != "marvis chat get "+memberChat {
		t.Errorf("a member's own chat = %+v", s)
	}

	testutil.Call(t, testHandler.ListKbSources, withMemberCtx(t, newRequest(http.MethodGet, "/api/kb/sources", nil))).Want(http.StatusBadRequest)
	testutil.Call(t, testHandler.ListKbSources, withMemberCtx(t, newRequest(http.MethodGet, path+"&kinds=issue", nil))).Want(http.StatusBadRequest)
	testutil.Call(t, testHandler.ListKbSources, withMemberCtx(t, newRequest(http.MethodGet, "/api/kb/sources?kb="+slug+"&since=yesterday", nil))).Want(http.StatusBadRequest)
}
