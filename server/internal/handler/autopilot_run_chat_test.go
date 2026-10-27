package handler

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/yunboom/marvis/server/internal/testutil"
)

// runChatFixture is a run_only autopilot owned by the test user whose single
// run executed on a private agent the test user owns.
type runChatFixture struct {
	autopilotID string
	agentID     string
	runtimeID   string
	projectID   string
	title       string
}

func newRunChatFixture(t *testing.T, mode string) runChatFixture {
	t.Helper()

	title := fmt.Sprintf("run chat %d", time.Now().UnixNano())
	runtimeID := dbfx.Runtime(t, title)
	agentID := dbfx.Agent(t, title, runtimeID)
	// The handler creates the chat session, which dbfx cannot register.
	dbfx.Cleanup(t, `DELETE FROM chat_session WHERE agent_id = $1`, agentID)
	projectID := dbfx.Project(t, title)
	autopilotID := dbfx.Insert(t, "autopilot", testutil.Cols{
		"workspace_id":         testWorkspaceID,
		"title":                title,
		"project_id":           projectID,
		"assignee_id":          agentID,
		"assignee_type":        "agent",
		"execution_mode":       mode,
		"issue_title_template": title,
		"status":               "active",
		"created_by_type":      "member",
		"created_by_id":        testUserID,
	})

	return runChatFixture{autopilotID: autopilotID, agentID: agentID, runtimeID: runtimeID, projectID: projectID, title: title}
}

// run inserts a run, with a task on the fixture's agent when task is not nil.
func (fx runChatFixture) run(t *testing.T, task testutil.Cols) string {
	t.Helper()

	runID, _ := fx.runWithTask(t, task)

	return runID
}

// runWithTask is run that also returns the task id ("" without a task). The
// task points back at its run, as dispatched run_only tasks do.
func (fx runChatFixture) runWithTask(t *testing.T, task testutil.Cols) (runID, taskID string) {
	t.Helper()

	cols := testutil.Cols{
		"autopilot_id": fx.autopilotID,
		"source":       "manual",
		"status":       "completed",
	}
	if task != nil {
		taskCols := testutil.Cols{"runtime_id": fx.runtimeID}
		for k, v := range task {
			taskCols[k] = v
		}
		taskID = dbfx.Task(t, fx.agentID, taskCols)
		cols["task_id"] = taskID
	}

	runID = dbfx.Insert(t, "autopilot_run", cols)
	if taskID != "" {
		dbfx.Exec(t, `UPDATE agent_task_queue SET autopilot_run_id = $1 WHERE id = $2`, runID, taskID)
	}

	return runID, taskID
}

func ensureRunChatRequest(userID, autopilotID, runID string) *http.Request {
	req := newRequestAs(userID, "POST", "/api/autopilots/"+autopilotID+"/runs/"+runID+"/chat", nil)

	return withURLParams(req, "id", autopilotID, "runId", runID)
}

type ensureRunChatResponse struct {
	ChatSessionID string `json:"chat_session_id"`
	Code          string `json:"code"`
}

func TestEnsureAutopilotRunChat_CreatesSessionResumingTheRun(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := newRunChatFixture(t, "run_only")
	runID := fx.run(t, testutil.Cols{
		"status":     "completed",
		"session_id": "provider-session-1",
		"work_dir":   "/tmp/run-chat-workdir",
		"runtime_id": fx.runtimeID,
	})

	var first ensureRunChatResponse
	testutil.Call(t, testHandler.EnsureAutopilotRunChat, ensureRunChatRequest(testUserID, fx.autopilotID, runID)).
		Want(http.StatusOK).JSON(&first)
	if first.ChatSessionID == "" {
		t.Fatal("chat_session_id is empty")
	}

	var agentID, creatorID, title, projectID, sessionID, workDir, runtimeID string
	dbfx.QueryRow(t, `SELECT agent_id::text, creator_id::text, title, project_id::text, session_id, work_dir, runtime_id::text
		FROM chat_session WHERE id = $1`, first.ChatSessionID).
		Scan(&agentID, &creatorID, &title, &projectID, &sessionID, &workDir, &runtimeID)
	if agentID != fx.agentID || creatorID != testUserID || title != fx.title || projectID != fx.projectID {
		t.Fatalf("session = agent %s creator %s title %q project %s, want %s %s %q %s",
			agentID, creatorID, title, projectID, fx.agentID, testUserID, fx.title, fx.projectID)
	}
	if sessionID != "provider-session-1" || workDir != "/tmp/run-chat-workdir" || runtimeID != fx.runtimeID {
		t.Fatalf("resume pointer = %q %q %s, want the run task's", sessionID, workDir, runtimeID)
	}

	var linked string
	dbfx.QueryRow(t, `SELECT chat_session_id::text FROM autopilot_run WHERE id = $1`, runID).Scan(&linked)
	if linked != first.ChatSessionID {
		t.Fatalf("autopilot_run.chat_session_id = %s, want %s", linked, first.ChatSessionID)
	}

	var second ensureRunChatResponse
	testutil.Call(t, testHandler.EnsureAutopilotRunChat, ensureRunChatRequest(testUserID, fx.autopilotID, runID)).
		Want(http.StatusOK).JSON(&second)
	if second.ChatSessionID != first.ChatSessionID {
		t.Fatalf("second call returned %s, want the existing %s", second.ChatSessionID, first.ChatSessionID)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_session WHERE agent_id = $1`, fx.agentID); n != 1 {
		t.Fatalf("chat sessions for the agent = %d, want 1", n)
	}

	var run AutopilotRunResponse
	getReq := withURLParams(newRequest("GET", "/api/autopilots/"+fx.autopilotID+"/runs/"+runID, nil), "id", fx.autopilotID, "runId", runID)
	testutil.Call(t, testHandler.GetAutopilotRun, getReq).Want(http.StatusOK).JSON(&run)
	if run.ChatSessionID == nil || *run.ChatSessionID != first.ChatSessionID {
		t.Fatalf("run detail chat_session_id = %v, want %s", run.ChatSessionID, first.ChatSessionID)
	}
	if run.AgentID == nil || *run.AgentID != fx.agentID {
		t.Fatalf("run detail agent_id = %v, want %s", run.AgentID, fx.agentID)
	}
}

func TestEnsureAutopilotRunChat_UnresumableFailureKeepsOnlyWorkDir(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := newRunChatFixture(t, "run_only")
	runID := fx.run(t, testutil.Cols{
		"status":         "failed",
		"failure_reason": "agent_error.context_overflow",
		"session_id":     "poisoned-session",
		"work_dir":       "/tmp/run-chat-poisoned",
		"runtime_id":     fx.runtimeID,
	})

	var resp ensureRunChatResponse
	testutil.Call(t, testHandler.EnsureAutopilotRunChat, ensureRunChatRequest(testUserID, fx.autopilotID, runID)).
		Want(http.StatusOK).JSON(&resp)

	var sessionID *string
	var workDir string
	dbfx.QueryRow(t, `SELECT session_id, work_dir FROM chat_session WHERE id = $1`, resp.ChatSessionID).Scan(&sessionID, &workDir)
	if sessionID != nil {
		t.Fatalf("session_id = %q, want NULL for an unresumable failure", *sessionID)
	}
	if workDir != "/tmp/run-chat-poisoned" {
		t.Fatalf("work_dir = %q, want the run task's", workDir)
	}
}

func TestEnsureAutopilotRunChat_Refusals(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	cases := []struct {
		name     string
		mode     string
		task     testutil.Cols
		issue    bool
		wantCode string
	}{
		{name: "create_issue run", mode: "create_issue", task: testutil.Cols{"status": "completed"}, issue: true, wantCode: autopilotRunChatCodeModeUnsupported},
		// The autopilot switched to run_only after this run created its issue.
		{name: "create_issue run under a run_only autopilot", mode: "run_only", task: testutil.Cols{"status": "completed"}, issue: true, wantCode: autopilotRunChatCodeModeUnsupported},
		{name: "run without a task", mode: "run_only", task: nil, wantCode: autopilotRunChatCodeNoSession},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newRunChatFixture(t, tc.mode)
			runID := fx.run(t, tc.task)
			if tc.issue {
				dbfx.Exec(t, `UPDATE autopilot_run SET issue_id = $1 WHERE id = $2`, dbfx.Issue(t, fx.title), runID)
			}

			var resp ensureRunChatResponse
			testutil.Call(t, testHandler.EnsureAutopilotRunChat, ensureRunChatRequest(testUserID, fx.autopilotID, runID)).
				Want(http.StatusConflict).JSON(&resp)
			if resp.Code != tc.wantCode {
				t.Fatalf("code = %q, want %q", resp.Code, tc.wantCode)
			}
			if n := dbfx.Count(t, `SELECT count(*) FROM autopilot_run WHERE id = $1 AND chat_session_id IS NOT NULL`, runID); n != 0 {
				t.Fatal("a refused run got a chat session")
			}
		})
	}
}

// A run_only run keeps its conversation after the autopilot switches to
// create_issue: the run, not the autopilot's current mode, decides.
func TestEnsureAutopilotRunChat_RunOnlyRunAfterModeSwitch(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := newRunChatFixture(t, "create_issue")
	runID := fx.run(t, testutil.Cols{
		"status":     "completed",
		"session_id": "provider-session-switched",
		"work_dir":   "/tmp/run-chat-switched",
		"runtime_id": fx.runtimeID,
	})

	var resp ensureRunChatResponse
	testutil.Call(t, testHandler.EnsureAutopilotRunChat, ensureRunChatRequest(testUserID, fx.autopilotID, runID)).
		Want(http.StatusOK).JSON(&resp)
	if resp.ChatSessionID == "" {
		t.Fatal("chat_session_id is empty")
	}
}

func TestEnsureAutopilotRunChat_RunningRunGetsSessionWithoutPointer(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := newRunChatFixture(t, "run_only")
	runID := fx.run(t, testutil.Cols{
		"status":     "running",
		"session_id": "mid-flight-session",
		"work_dir":   "/tmp/run-chat-mid-flight",
		"runtime_id": fx.runtimeID,
	})

	var resp ensureRunChatResponse
	testutil.Call(t, testHandler.EnsureAutopilotRunChat, ensureRunChatRequest(testUserID, fx.autopilotID, runID)).
		Want(http.StatusOK).JSON(&resp)
	if resp.ChatSessionID == "" {
		t.Fatal("chat_session_id is empty")
	}

	var sessionID, workDir *string
	dbfx.QueryRow(t, `SELECT session_id, work_dir FROM chat_session WHERE id = $1`, resp.ChatSessionID).
		Scan(&sessionID, &workDir)
	if sessionID != nil || workDir != nil {
		t.Fatalf("resume pointer = %v %v, want empty until the run settles", sessionID, workDir)
	}
	var linked string
	dbfx.QueryRow(t, `SELECT chat_session_id::text FROM autopilot_run WHERE id = $1`, runID).Scan(&linked)
	if linked != resp.ChatSessionID {
		t.Fatalf("autopilot_run.chat_session_id = %s, want %s", linked, resp.ChatSessionID)
	}
}

func TestEnsureAutopilotRunChat_RequiresInvokePermission(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := newRunChatFixture(t, "run_only")
	runID := fx.run(t, testutil.Cols{"status": "completed"})
	outsider := plainMember(t, "run-chat-outsider")

	testutil.Call(t, testHandler.EnsureAutopilotRunChat, ensureRunChatRequest(outsider, fx.autopilotID, runID)).
		Want(http.StatusForbidden)
	if n := dbfx.Count(t, `SELECT count(*) FROM autopilot_run WHERE id = $1 AND chat_session_id IS NOT NULL`, runID); n != 0 {
		t.Fatal("a refused caller got a chat session")
	}
}

func TestEnsureAutopilotRunChat_RunOfAnotherAutopilotIsNotFound(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := newRunChatFixture(t, "run_only")
	other := newRunChatFixture(t, "run_only")
	runID := other.run(t, testutil.Cols{"status": "completed"})

	testutil.Call(t, testHandler.EnsureAutopilotRunChat, ensureRunChatRequest(testUserID, fx.autopilotID, runID)).
		Want(http.StatusNotFound)
}
