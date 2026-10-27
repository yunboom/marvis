package service

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"

	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// taskStatusFailed is the agent_task_queue status of a task that failed.
const taskStatusFailed = "failed"

// RunChatResumePointer points a run's follow-up chat session at the run
// task's provider session, work dir and runtime. A task that failed in a way
// that poisons its conversation, or whose session was retired, keeps only the
// work dir and runtime, matching the GetLastTaskSession resume filter.
func RunChatResumePointer(chatSessionID pgtype.UUID, task db.AgentTaskQueue) db.UpdateChatSessionSessionParams {
	params := db.UpdateChatSessionSessionParams{
		ID:        chatSessionID,
		SessionID: task.SessionID,
		WorkDir:   task.WorkDir,
		RuntimeID: task.RuntimeID,
	}

	unresumable := task.Status == taskStatusFailed && ResumeUnsafeFailure(task.FailureReason.String, task.Error.String)
	retired := task.RetiredSessionID.Valid && task.RetiredSessionID.String == task.SessionID.String
	if unresumable || retired {
		params.SessionID = pgtype.Text{}
	}

	return params
}

// pinAutopilotRunChatSessions writes each settling autopilot task's resume
// pointer onto its run's follow-up chat session, so messages queued on that
// session while the run executed continue the run's conversation.
//
// It runs in the terminal transaction: the claim query holds those messages
// back while any task of the run is unsettled, so the pointer and the status
// flip that releases them commit together. The run rows are locked first to
// serialize with EnsureAutopilotRunChat linking a session concurrently.
func pinAutopilotRunChatSessions(ctx context.Context, q *db.Queries, tasks ...db.AgentTaskQueue) error {
	runIDs := make([]pgtype.UUID, 0, len(tasks))
	for _, task := range tasks {
		if task.AutopilotRunID.Valid {
			runIDs = append(runIDs, task.AutopilotRunID)
		}
	}
	if len(runIDs) == 0 {
		return nil
	}

	runs, err := q.LockAutopilotRunChatSessionsForTaskSettle(ctx, runIDs)
	if err != nil {
		return errors.Wrap(err, "lock autopilot runs for chat pointer")
	}
	chatSessionByRun := make(map[pgtype.UUID]pgtype.UUID, len(runs))
	for _, run := range runs {
		if run.ChatSessionID.Valid {
			chatSessionByRun[run.ID] = run.ChatSessionID
		}
	}
	if len(chatSessionByRun) == 0 {
		return nil
	}

	var params db.UpdateChatSessionSessionsParams
	for _, task := range tasks {
		chatSessionID, ok := chatSessionByRun[task.AutopilotRunID]
		if !task.AutopilotRunID.Valid || !ok {
			continue
		}

		pointer := RunChatResumePointer(chatSessionID, task)
		params.Ids = append(params.Ids, pointer.ID)
		params.SessionIds = append(params.SessionIds, pointer.SessionID.String)
		params.WorkDirs = append(params.WorkDirs, pointer.WorkDir.String)
		params.RuntimeIds = append(params.RuntimeIds, pointer.RuntimeID)
	}
	if err := q.UpdateChatSessionSessions(ctx, params); err != nil {
		return errors.Wrap(err, "pin autopilot run chat sessions")
	}

	return nil
}
