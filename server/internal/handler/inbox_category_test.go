package handler

import (
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/yunboom/marvis/server/internal/testutil"
)

// TestInboxCategories: the archive, its facets and mark-all-read narrow to
// one inbox category (decision 108); an unknown category is 400.
func TestInboxCategories(t *testing.T) {
	ws := dbfx.Workspace(t, "Inbox categories", "inbox-cat-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	insert := func(kind string, archived bool) string {
		return dbfx.Insert(t, "inbox_item", testutil.Cols{
			"workspace_id": ws, "recipient_type": "member", "recipient_id": testUserID,
			"type": kind, "severity": "info", "title": kind, "archived": archived,
		})
	}
	issueItem := insert("mentioned", true)
	kbItem := insert("kb_mr_changes_requested", true)
	insert("autopilot_paused", true)
	insert("something_new", true)

	page := func(query string) []string {
		var got archivedInboxPageResponse
		testutil.Call(t, inboxWorkspaceHandler(testHandler.ListArchivedInboxPage), inboxRequest(http.MethodGet, "/api/inbox/archived/page?"+query, ws)).Want(http.StatusOK).JSON(&got)
		ids := make([]string, len(got.Items))
		for i, item := range got.Items {
			ids[i] = item.ID
		}
		return ids
	}
	if got := page("category=kb"); len(got) != 1 || got[0] != kbItem {
		t.Errorf("kb archive = %v", got)
	}
	if got := page("category=issue"); len(got) != 1 || got[0] != issueItem {
		t.Errorf("issue archive = %v", got)
	}
	if got := page(""); len(got) != 4 {
		t.Errorf("all archive = %v, want every type including unknown ones", got)
	}
	var facets archivedInboxFacetsResponse
	testutil.Call(t, inboxWorkspaceHandler(testHandler.GetArchivedInboxFacets), inboxRequest(http.MethodGet, "/api/inbox/archived/facets?category=autopilot", ws)).Want(http.StatusOK).JSON(&facets)
	if facets.UnreadCount != 1 {
		t.Errorf("autopilot facets = %+v", facets)
	}
	testutil.Call(t, inboxWorkspaceHandler(testHandler.ListArchivedInboxPage), inboxRequest(http.MethodGet, "/api/inbox/archived/page?category=chat", ws)).Want(http.StatusBadRequest)

	// Mark all read touches only the active notifications of the category.
	activeKb := insert("kb_mr_review_requested", false)
	activeIssue := insert("mentioned", false)
	var marked map[string]any
	testutil.Call(t, inboxWorkspaceHandler(testHandler.MarkAllInboxRead), inboxRequest(http.MethodPost, "/api/inbox/mark-all-read?category=kb", ws)).Want(http.StatusOK).JSON(&marked)
	if marked["count"] != float64(1) {
		t.Errorf("marked = %v", marked)
	}
	var kbRead, issueRead bool
	dbfx.QueryRow(t, `SELECT read FROM inbox_item WHERE id = $1`, activeKb).Scan(&kbRead)
	dbfx.QueryRow(t, `SELECT read FROM inbox_item WHERE id = $1`, activeIssue).Scan(&issueRead)
	if !kbRead || issueRead {
		t.Errorf("read: kb %v issue %v", kbRead, issueRead)
	}
	testutil.Call(t, inboxWorkspaceHandler(testHandler.MarkAllInboxRead), inboxRequest(http.MethodPost, "/api/inbox/mark-all-read?category=bad", ws)).Want(http.StatusBadRequest)
}
