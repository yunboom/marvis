package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/yunboom/marvis/server/internal/issuestatus"
	"github.com/yunboom/marvis/server/internal/testutil"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// createArchivedTestStatus creates a custom status and archives it, the only
// state a status can be permanently deleted from.
func createArchivedTestStatus(t *testing.T, key string) db.IssueStatus {
	t.Helper()
	entry := createTestCustomStatus(t, key, issuestatus.InProgress)
	if _, err := testHandler.Queries.ArchiveIssueStatusEntry(context.Background(), db.ArchiveIssueStatusEntryParams{
		ID:          entry.ID,
		WorkspaceID: entry.WorkspaceID,
	}); err != nil {
		t.Fatalf("archive %q: %v", key, err)
	}
	return entry
}

func deleteIssueStatusRequest(entry db.IssueStatus) *http.Request {
	id := uuidToString(entry.ID)
	return withURLParam(newRequest(http.MethodDelete, "/api/issue-statuses/"+id+"/permanent", nil), "id", id)
}

func issueStatusRowExists(t *testing.T, entry db.IssueStatus) bool {
	t.Helper()
	return dbfx.Count(t, "SELECT count(*) FROM issue_status WHERE id = $1", entry.ID) == 1
}

func TestDeleteIssueStatusRemovesAnUnreferencedArchivedStatus(t *testing.T) {
	entry := createArchivedTestStatus(t, "delete_unused")

	testutil.Call(t, testHandler.DeleteIssueStatus, deleteIssueStatusRequest(entry)).Want(http.StatusNoContent)

	if issueStatusRowExists(t, entry) {
		t.Fatal("unreferenced archived status was not deleted")
	}
}

func TestDeleteIssueStatusRequiresArchiving(t *testing.T) {
	entry := createTestCustomStatus(t, "delete_active", issuestatus.InProgress)

	var conflict struct {
		Code string `json:"code"`
	}
	testutil.Call(t, testHandler.DeleteIssueStatus, deleteIssueStatusRequest(entry)).
		Want(http.StatusConflict).
		JSON(&conflict)

	if conflict.Code != "issue_status_not_archived" {
		t.Fatalf("code = %q, want issue_status_not_archived", conflict.Code)
	}
	if !issueStatusRowExists(t, entry) {
		t.Fatal("active status was deleted")
	}
}

func TestDeleteIssueStatusRefusesABuiltIn(t *testing.T) {
	seedTestCatalog(t)
	builtIn, err := testHandler.Queries.GetIssueStatusEntryByKey(context.Background(), db.GetIssueStatusEntryByKeyParams{
		WorkspaceID: parseUUID(testWorkspaceID),
		Key:         issuestatus.Todo,
	})
	if err != nil {
		t.Fatalf("load built-in: %v", err)
	}

	testutil.Call(t, testHandler.DeleteIssueStatus, deleteIssueStatusRequest(builtIn)).Want(http.StatusForbidden)
}

// Every place that stores the key — live configuration and history alike —
// keeps the status from being deleted.
func TestDeleteIssueStatusRefusesAReferencedKey(t *testing.T) {
	issueID := dbfx.Issue(t, "status history holder")

	cases := []struct {
		ref       string
		reference func(t *testing.T, key string)
	}{
		{"activity", func(t *testing.T, key string) {
			dbfx.Insert(t, "activity_log", testutil.Cols{
				"workspace_id": testWorkspaceID,
				"issue_id":     issueID,
				"action":       "status_changed",
				"details":      map[string]string{"from": key, "to": issuestatus.Done},
			})
		}},
		{"inbox", func(t *testing.T, key string) {
			dbfx.Insert(t, "inbox_item", testutil.Cols{
				"workspace_id":   testWorkspaceID,
				"recipient_type": "member",
				"recipient_id":   testUserID,
				"type":           "status_changed",
				"severity":       "info",
				"issue_id":       issueID,
				"title":          "status changed",
				"details":        map[string]string{"from": issuestatus.Todo, "to": key},
			})
		}},
		{"saved_view", func(t *testing.T, key string) {
			dbfx.Insert(t, "issue_view", testutil.Cols{
				"workspace_id": testWorkspaceID,
				"owner_id":     testUserID,
				"name":         "filtered by " + key,
				"scope_type":   "workspace",
				"query":        map[string]any{"statusFilters": []string{issuestatus.Todo, key}},
			})
		}},
		{"wakeup", func(t *testing.T, key string) {
			dbfx.Insert(t, "issue_wakeup", testutil.Cols{
				"id":           uuid.NewString(),
				"workspace_id": testWorkspaceID,
				"issue_id":     issueID,
				"instruction":  "wake when the status is reached",
				"kind":         "event",
				"mode":         "once",
				"condition":    map[string]string{"type": "issue_field", "field": "status", "value": key},
			})
		}},
		{"workflow", func(t *testing.T, key string) {
			dbfx.Insert(t, "issue_workflow", testutil.Cols{
				"workspace_id":       testWorkspaceID,
				"name":               "routes back to " + key,
				"initial_status_key": issuestatus.Todo,
				"steps": []map[string]string{
					{"status_key": issuestatus.InReview, "back_status_key": key},
				},
			})
		}},
	}

	for _, tc := range cases {
		t.Run(tc.ref, func(t *testing.T) {
			entry := createArchivedTestStatus(t, "delete_ref_"+tc.ref)
			tc.reference(t, entry.Key)

			var conflict struct {
				Code       string   `json:"code"`
				References []string `json:"references"`
			}
			testutil.Call(t, testHandler.DeleteIssueStatus, deleteIssueStatusRequest(entry)).
				Want(http.StatusConflict).
				JSON(&conflict)

			if conflict.Code != "issue_status_referenced" || len(conflict.References) != 1 || conflict.References[0] != tc.ref {
				t.Fatalf("conflict = %+v, want issue_status_referenced naming %q", conflict, tc.ref)
			}
			if !issueStatusRowExists(t, entry) {
				t.Fatal("referenced status was deleted")
			}
		})
	}
}
