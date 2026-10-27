package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/yunboom/marvis/server/internal/issuestatus"
	"github.com/yunboom/marvis/server/internal/testutil"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// TestBuiltInStatusesCarryFixedGroups pins the seeded groups: in_review and
// blocked wait on a person, every other built-in sits in its category's group.
func TestBuiltInStatusesCarryFixedGroups(t *testing.T) {
	seedTestCatalog(t)
	entries, err := testHandler.Queries.ListIssueStatusEntries(context.Background(), db.ListIssueStatusEntriesParams{
		WorkspaceID: parseUUID(testWorkspaceID),
	})
	if err != nil {
		t.Fatalf("list catalog: %v", err)
	}

	want := map[string]string{
		issuestatus.Backlog:    issuestatus.GroupNotStarted,
		issuestatus.Todo:       issuestatus.GroupNotStarted,
		issuestatus.InProgress: issuestatus.GroupWorking,
		issuestatus.InReview:   issuestatus.GroupNeedsAttention,
		issuestatus.Blocked:    issuestatus.GroupNeedsAttention,
		issuestatus.Done:       issuestatus.GroupEnded,
		issuestatus.Cancelled:  issuestatus.GroupEnded,
	}
	for _, e := range entries {
		if !e.IsSystem {
			continue
		}
		if e.StatusGroup != want[e.Key] {
			t.Errorf("built-in %s group = %q, want %q", e.Key, e.StatusGroup, want[e.Key])
		}
	}
}

func TestCreateIssueStatusGroup(t *testing.T) {
	seedTestCatalog(t)

	cases := []struct {
		name      string
		category  string
		group     string
		wantCode  int
		wantGroup string
	}{
		{"started defaults to working", issuestatus.CategoryStarted, "", http.StatusCreated, issuestatus.GroupWorking},
		{"started may wait on a person", issuestatus.CategoryStarted, issuestatus.GroupNeedsAttention, http.StatusCreated, issuestatus.GroupNeedsAttention},
		{"unstarted defaults to not started", issuestatus.CategoryUnstarted, "", http.StatusCreated, issuestatus.GroupNotStarted},
		{"closed defaults to ended", issuestatus.CategoryClosed, "", http.StatusCreated, issuestatus.GroupEnded},
		{"unstarted cannot be working", issuestatus.CategoryUnstarted, issuestatus.GroupWorking, http.StatusBadRequest, ""},
		{"done cannot need attention", issuestatus.CategoryDone, issuestatus.GroupNeedsAttention, http.StatusBadRequest, ""},
		{"unknown group", issuestatus.CategoryStarted, "waiting", http.StatusBadRequest, ""},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := map[string]any{
				"name": "group case " + string(rune('a'+i)), "category": tc.category, "status_group": tc.group, "color": "#123456",
			}
			call := testutil.Call(t, testHandler.CreateIssueStatus, newRequest(http.MethodPost, "/api/issue-statuses", body)).Want(tc.wantCode)
			if tc.wantCode != http.StatusCreated {
				return
			}

			var created IssueStatusResponse
			call.JSON(&created)
			dbfx.Cleanup(t, `DELETE FROM issue_status WHERE id = $1`, parseUUID(created.ID))
			if created.StatusGroup != tc.wantGroup {
				t.Errorf("status_group = %q, want %q", created.StatusGroup, tc.wantGroup)
			}
		})
	}
}

func TestUpdateIssueStatusGroup(t *testing.T) {
	started := createTestCustomStatus(t, "group_started", issuestatus.CategoryStarted)
	done := createTestCustomStatus(t, "group_done", issuestatus.CategoryDone)

	patch := func(entry db.IssueStatus, group string) *testutil.Response {
		req := withURLParam(
			newRequest(http.MethodPatch, "/api/issue-statuses/"+uuidToString(entry.ID), map[string]any{"status_group": group}),
			"id", uuidToString(entry.ID))
		return testutil.Call(t, testHandler.UpdateIssueStatus, req)
	}

	var moved IssueStatusResponse
	patch(started, issuestatus.GroupNeedsAttention).Want(http.StatusOK).JSON(&moved)
	if moved.StatusGroup != issuestatus.GroupNeedsAttention {
		t.Fatalf("status_group = %q, want %q", moved.StatusGroup, issuestatus.GroupNeedsAttention)
	}
	patch(started, issuestatus.GroupWorking).Want(http.StatusOK).JSON(&moved)
	if moved.StatusGroup != issuestatus.GroupWorking {
		t.Fatalf("status_group = %q, want %q", moved.StatusGroup, issuestatus.GroupWorking)
	}

	patch(started, issuestatus.GroupEnded).Want(http.StatusBadRequest)
	patch(done, issuestatus.GroupNeedsAttention).Want(http.StatusBadRequest)
}

// TestIssueStatusGroupConstraints covers the storage rules behind the API: an
// insert without a group takes the category default, a mismatched pair is
// rejected, and a built-in cannot leave its fixed group.
func TestIssueStatusGroupConstraints(t *testing.T) {
	ctx := context.Background()
	seedTestCatalog(t)

	var group string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue_status (workspace_id, key, name, category, color)
		VALUES ($1, 'group_default', 'group_default', 'started', '#123456')
		RETURNING status_group`, parseUUID(testWorkspaceID)).Scan(&group); err != nil {
		t.Fatalf("insert without group: %v", err)
	}
	dbfx.Cleanup(t, `DELETE FROM issue_status WHERE workspace_id = $1 AND key = 'group_default'`, parseUUID(testWorkspaceID))
	if group != issuestatus.GroupWorking {
		t.Errorf("default group = %q, want %q", group, issuestatus.GroupWorking)
	}

	if _, err := testPool.Exec(ctx, `
		INSERT INTO issue_status (workspace_id, key, name, category, status_group, color)
		VALUES ($1, 'group_mismatch', 'group_mismatch', 'done', 'working', '#123456')`, parseUUID(testWorkspaceID)); err == nil {
		dbfx.Cleanup(t, `DELETE FROM issue_status WHERE workspace_id = $1 AND key = 'group_mismatch'`, parseUUID(testWorkspaceID))
		t.Error("a done status must not be stored as working")
	}

	if _, err := testPool.Exec(ctx, `
		UPDATE issue_status SET status_group = 'working'
		WHERE workspace_id = $1 AND key = 'in_review'`, parseUUID(testWorkspaceID)); err == nil {
		t.Error("in_review must stay in needs_attention")
	}
}

func TestIssueResponseCarriesStatusGroup(t *testing.T) {
	seedTestCatalog(t)
	entry := createTestCustomStatus(t, "group_waiting", issuestatus.CategoryStarted)
	if _, err := testPool.Exec(context.Background(),
		`UPDATE issue_status SET status_group = 'needs_attention' WHERE id = $1`, entry.ID); err != nil {
		t.Fatalf("move custom status: %v", err)
	}

	cases := []struct {
		status string
		want   string
	}{
		{"group_waiting", issuestatus.GroupNeedsAttention},
		{issuestatus.InReview, issuestatus.GroupNeedsAttention},
		{issuestatus.Todo, issuestatus.GroupNotStarted},
	}
	for _, tc := range cases {
		var resp IssueResponse
		testutil.Call(t, testHandler.CreateIssue,
			newRequest(http.MethodPost, "/api/issues", map[string]any{
				"title": "status group " + tc.status, "status": tc.status,
			})).Want(http.StatusCreated).JSON(&resp)
		dbfx.Cleanup(t, `DELETE FROM issue WHERE id = $1`, parseUUID(resp.ID))
		if resp.StatusGroup != tc.want {
			t.Errorf("%s: status_group = %q, want %q", tc.status, resp.StatusGroup, tc.want)
		}
	}
}

// TestWorkflowNewStatusKeepsItsGroup covers the workflow write path a template
// uses to create a waiting status straight into needs_attention.
func TestWorkflowNewStatusKeepsItsGroup(t *testing.T) {
	seedTestCatalog(t)
	resetDefaultWorkflow(t)
	statusName := "Waiting " + workflowTestSuffix()[10:]

	var created IssueWorkflowResponse
	testutil.Call(t, testHandler.CreateIssueWorkflow, workflowRequest("POST", "/api/issue-workflows", map[string]any{
		"name": "Group " + workflowTestSuffix(),
		"steps": []map[string]any{
			{"new_status": map[string]any{"name": statusName, "category": "started", "status_group": "needs_attention"}},
			{"status_key": "in_review"},
		},
	})).Want(http.StatusCreated).JSON(&created)
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM issue_workflow WHERE id = $1`, created.ID)
		testPool.Exec(context.Background(), `DELETE FROM issue_status WHERE workspace_id = $1 AND name = $2`, testWorkspaceID, statusName)
	})

	var group string
	dbfx.QueryRow(t, `SELECT status_group FROM issue_status WHERE workspace_id = $1 AND name = $2`, testWorkspaceID, statusName).Scan(&group)
	if group != issuestatus.GroupNeedsAttention {
		t.Errorf("status_group = %q, want %q", group, issuestatus.GroupNeedsAttention)
	}
}
