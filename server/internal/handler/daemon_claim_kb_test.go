package handler

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/testutil"
)

// claimKbTask claims a fresh task in the handler test workspace and returns
// the task object of the claim response.
func claimKbTask(t *testing.T, label string) map[string]any {
	t.Helper()

	ctx := context.Background()
	runtimeID := createClaimReclaimRuntime(t, ctx, label+" runtime")
	agentID, issueID := createClaimReclaimAgentAndIssue(t, ctx, runtimeID, label+" agent")
	taskID := createDispatchedClaimFixtureTask(t, ctx, agentID, runtimeID, issueID, "120 seconds", false)

	req := newOwnerDaemonRequest("POST", "/api/daemon/runtimes/"+runtimeID+"/tasks/claim", nil)
	req = withURLParam(req, "runtimeId", runtimeID)
	var resp struct {
		Task map[string]any `json:"task"`
	}
	testutil.Call(t, testHandler.ClaimTaskByRuntime, req).Want(http.StatusOK).JSON(&resp)
	if resp.Task == nil || resp.Task["id"] != taskID {
		t.Fatalf("expected task %s to be claimed, got %+v", taskID, resp.Task)
	}

	return resp.Task
}

// TestClaimTaskByRuntime_ListsKnowledgeBases: the claim lists this
// workspace's knowledge bases by name with slug, name and description, and
// nothing from another workspace.
func TestClaimTaskByRuntime_ListsKnowledgeBases(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	insertTestKbBase(t, "Team knowledge", "team", testutil.Cols{"description": "Orders, payments, release and test processes."})
	insertTestKbBase(t, "Payment troubleshooting", "pay-troubleshoot", testutil.Cols{"description": ""})
	otherWorkspace := dbfx.Workspace(t, "KB claim other", fmt.Sprintf("kb-claim-other-%d", time.Now().UnixNano()))
	other := dbfx.Insert(t, "kb_base", testutil.Cols{
		"workspace_id": otherWorkspace, "name": "Another workspace", "slug": "elsewhere", "schema_mode": kb.SchemaModeDefault,
		"schema": "# Schema", "created_by": testUserID,
	})
	dbfx.Cleanup(t, `DELETE FROM kb_base WHERE id = $1`, other)

	task := claimKbTask(t, "KB claim")

	got, _ := task["knowledge_bases"].([]any)
	want := []map[string]any{
		{"slug": "pay-troubleshoot", "name": "Payment troubleshooting", "description": ""},
		{"slug": "team", "name": "Team knowledge", "description": "Orders, payments, release and test processes."},
	}
	if len(got) != len(want) {
		t.Fatalf("knowledge_bases = %+v, want %+v", got, want)
	}
	for i, w := range want {
		entry, _ := got[i].(map[string]any)
		for k, v := range w {
			if entry[k] != v {
				t.Errorf("knowledge_bases[%d].%s = %v, want %v", i, k, entry[k], v)
			}
		}
	}
	if _, present := task["knowledge_bases_truncated"]; present {
		t.Error("knowledge_bases_truncated must be absent under the cap")
	}
}

// TestClaimTaskByRuntime_KnowledgeBasesAbsentWithoutAny: a workspace without
// knowledge bases claims without the field, so the brief has no section.
func TestClaimTaskByRuntime_KnowledgeBasesAbsentWithoutAny(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	task := claimKbTask(t, "KB claim empty")
	if _, present := task["knowledge_bases"]; present {
		t.Errorf("knowledge_bases must be absent for a workspace without knowledge bases: %+v", task["knowledge_bases"])
	}
}

// TestClaimTaskByRuntime_KnowledgeBasesCap keeps the first 30 by name and
// says the list was cut.
func TestClaimTaskByRuntime_KnowledgeBasesCap(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	for i := 0; i < taskKnowledgeBaseCap+2; i++ {
		insertTestKbBase(t, fmt.Sprintf("KB %02d", i), fmt.Sprintf("kb-%02d", i))
	}

	task := claimKbTask(t, "KB claim cap")
	got, _ := task["knowledge_bases"].([]any)
	if len(got) != taskKnowledgeBaseCap {
		t.Fatalf("knowledge_bases has %d entries, want %d", len(got), taskKnowledgeBaseCap)
	}
	last, _ := got[len(got)-1].(map[string]any)
	if last["slug"] != fmt.Sprintf("kb-%02d", taskKnowledgeBaseCap-1) {
		t.Errorf("last entry = %+v, want the %dth by name", last, taskKnowledgeBaseCap)
	}
	if task["knowledge_bases_truncated"] != true {
		t.Errorf("knowledge_bases_truncated = %v, want true", task["knowledge_bases_truncated"])
	}
}
