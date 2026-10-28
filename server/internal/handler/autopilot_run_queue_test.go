package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/yunboom/marvis/server/internal/testutil"
)

// runQueueFixture is a run_only autopilot on an online daemon runtime whose
// run is still executing, with the run's follow-up chat already created.
type runQueueFixture struct {
	agentID       string
	runtimeID     string
	runTaskID     string
	chatSessionID string
}

func newRunQueueFixture(t *testing.T) runQueueFixture {
	t.Helper()

	agentID, runtimeID, _ := createRuntimeGuardAgent(t, context.Background())
	dbfx.Cleanup(t, `DELETE FROM chat_session WHERE agent_id = $1`, agentID)
	autopilotID := dbfx.Insert(t, "autopilot", testutil.Cols{
		"workspace_id":         testWorkspaceID,
		"title":                "run queue " + t.Name(),
		"assignee_id":          agentID,
		"assignee_type":        "agent",
		"execution_mode":       "run_only",
		"issue_title_template": "run queue",
		"status":               "active",
		"created_by_type":      "member",
		"created_by_id":        testUserID,
	})
	fx := runChatFixture{autopilotID: autopilotID, agentID: agentID, runtimeID: runtimeID}
	runID, runTaskID := fx.runWithTask(t, testutil.Cols{"status": "running", "started_at": testutil.Raw("now()")})
	dbfx.Exec(t, `UPDATE autopilot_run SET status = 'running' WHERE id = $1`, runID)

	var resp ensureRunChatResponse
	testutil.Call(t, testHandler.EnsureAutopilotRunChat, ensureRunChatRequest(testUserID, autopilotID, runID)).
		Want(http.StatusOK).JSON(&resp)

	return runQueueFixture{
		agentID:       agentID,
		runtimeID:     runtimeID,
		runTaskID:     runTaskID,
		chatSessionID: resp.ChatSessionID,
	}
}

// queueChatTurn enqueues a chat turn on a session, as a send does.
func (fx runQueueFixture) queueChatTurn(t *testing.T, chatSessionID string) string {
	t.Helper()

	var taskID string
	dbfx.QueryRow(t, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, chat_session_id, status, priority)
		VALUES ($1, $2, $3, 'queued', 0)
		RETURNING id
	`, fx.agentID, fx.runtimeID, chatSessionID).Scan(&taskID)

	return taskID
}

// claimedRunQueueTask is the part of a claim response these tests read.
type claimedRunQueueTask struct {
	ID             string `json:"id"`
	PriorSessionID string `json:"prior_session_id"`
	PriorWorkDir   string `json:"prior_work_dir"`
}

// claimForRuntime claims as the runtime's owner daemon; nil when nothing is
// claimable.
func claimForRuntime(t *testing.T, runtimeID string) *claimedRunQueueTask {
	t.Helper()

	w := httptest.NewRecorder()
	req := newOwnerDaemonRequest("POST", "/api/daemon/runtimes/"+runtimeID+"/claim", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("runtimeId", runtimeID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	testHandler.ClaimTaskByRuntime(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("ClaimTaskByRuntime: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Task *claimedRunQueueTask `json:"task"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	return resp.Task
}

func TestRunFollowUpQueuedWhileRunning_ClaimedAfterRunCompletes(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newRunQueueFixture(t)
	followUpID := fx.queueChatTurn(t, fx.chatSessionID)

	if task := claimForRuntime(t, fx.runtimeID); task != nil {
		t.Fatalf("claimed %s while the run is executing, want the follow-up held", task.ID)
	}

	// Holding the run's follow-ups must not hold the agent's other chats.
	otherSession := dbfx.ChatSession(t, fx.agentID, testutil.Cols{"title": "unrelated chat"})
	otherTurn := fx.queueChatTurn(t, otherSession)
	if task := claimForRuntime(t, fx.runtimeID); task == nil || task.ID != otherTurn {
		t.Fatalf("claimed %v, want the unrelated chat turn %s", task, otherTurn)
	}

	if _, err := testHandler.TaskService.CompleteTask(ctx, parseUUID(fx.runTaskID), []byte(`{"output":"done"}`),
		"run-provider-session", "/tmp/run-queue-workdir", "", false, "", ""); err != nil {
		t.Fatalf("complete run task: %v", err)
	}

	var sessionID, workDir, runtimeID string
	dbfx.QueryRow(t, `SELECT session_id, work_dir, runtime_id::text FROM chat_session WHERE id = $1`, fx.chatSessionID).
		Scan(&sessionID, &workDir, &runtimeID)
	if sessionID != "run-provider-session" || workDir != "/tmp/run-queue-workdir" || runtimeID != fx.runtimeID {
		t.Fatalf("resume pointer = %q %q %s, want the run task's", sessionID, workDir, runtimeID)
	}

	task := claimForRuntime(t, fx.runtimeID)
	if task == nil || task.ID != followUpID {
		t.Fatalf("claimed %v, want the held follow-up %s", task, followUpID)
	}
	if task.PriorSessionID != "run-provider-session" || task.PriorWorkDir != "/tmp/run-queue-workdir" {
		t.Fatalf("prior = %q %q, want the run task's session and work dir", task.PriorSessionID, task.PriorWorkDir)
	}
}

func TestRunFollowUpQueuedWhileRunning_UnresumableFailureHandsOverOnlyWorkDir(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newRunQueueFixture(t)
	followUpID := fx.queueChatTurn(t, fx.chatSessionID)

	if _, err := testHandler.TaskService.FailTask(ctx, parseUUID(fx.runTaskID), "context window exceeded",
		"poisoned-run-session", "/tmp/run-queue-failed", "", "agent_error.context_overflow", false, "", ""); err != nil {
		t.Fatalf("fail run task: %v", err)
	}

	var sessionID *string
	var workDir string
	dbfx.QueryRow(t, `SELECT session_id, work_dir FROM chat_session WHERE id = $1`, fx.chatSessionID).Scan(&sessionID, &workDir)
	if sessionID != nil || workDir != "/tmp/run-queue-failed" {
		t.Fatalf("resume pointer = %v %q, want no session and the run task's work dir", sessionID, workDir)
	}

	task := claimForRuntime(t, fx.runtimeID)
	if task == nil || task.ID != followUpID {
		t.Fatalf("claimed %v, want the held follow-up %s", task, followUpID)
	}
	if task.PriorSessionID != "" || task.PriorWorkDir != "/tmp/run-queue-failed" {
		t.Fatalf("prior = %q %q, want a fresh session in the run task's work dir", task.PriorSessionID, task.PriorWorkDir)
	}
}

func TestRunFollowUpQueuedWhileRunning_HeldWhileRunRetryIsPending(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := newRunQueueFixture(t)
	fx.queueChatTurn(t, fx.chatSessionID)

	// The run task settled but its auto-retry, which carries the same run, has
	// not started yet: the run is not over.
	dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'failed', completed_at = now() WHERE id = $1`, fx.runTaskID)
	dbfx.Exec(t, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, autopilot_run_id, status, priority, fire_at, retry_of_task_id)
		SELECT agent_id, runtime_id, autopilot_run_id, 'deferred', 0, now() + interval '1 hour', id
		FROM agent_task_queue WHERE id = $1
	`, fx.runTaskID)

	if task := claimForRuntime(t, fx.runtimeID); task != nil {
		t.Fatalf("claimed %s while the run's retry is pending, want the follow-up held", task.ID)
	}
}
