package service

// agent_task_queue statuses, mirroring the agent_task_queue_status_check
// constraint. SQL that filters on these sets spells them inline (sqlc queries
// have no access to Go constants); such lists carry a "task status set" marker
// comment and TestTaskStatusSQLListsMatchGo keeps them in sync with this file.
const (
	// TaskStatusQueued is a task waiting to be claimed by a daemon.
	TaskStatusQueued = "queued"
	// TaskStatusDispatched is a task claimed by a daemon but not yet started.
	TaskStatusDispatched = "dispatched"
	// TaskStatusRunning is a task whose agent is executing.
	TaskStatusRunning = "running"
	// TaskStatusWaitingLocalDirectory is a task paused until its local work
	// directory becomes available.
	TaskStatusWaitingLocalDirectory = "waiting_local_directory"
	// TaskStatusDeferred is a task held back until its target can run.
	TaskStatusDeferred = "deferred"
	// TaskStatusCompleted is a task that finished successfully.
	TaskStatusCompleted = "completed"
	// TaskStatusFailed is a task that finished with an error.
	TaskStatusFailed = "failed"
	// TaskStatusCancelled is a task stopped before it finished.
	TaskStatusCancelled = "cancelled"
)

// TerminalTaskStatuses are the statuses of a finished task: it has written its
// session_id / work_dir back and will not change again.
var TerminalTaskStatuses = []string{TaskStatusCompleted, TaskStatusFailed, TaskStatusCancelled}

// UnsettledTaskStatuses are the statuses of a task that has not finished yet;
// together with TerminalTaskStatuses they cover every task status.
var UnsettledTaskStatuses = []string{
	TaskStatusQueued,
	TaskStatusDispatched,
	TaskStatusRunning,
	TaskStatusWaitingLocalDirectory,
	TaskStatusDeferred,
}

// IsTerminalTaskStatus reports whether a task has finished, in any of the three
// ways it can. A status this file does not know is treated as NOT terminal so
// an added in-flight state keeps working.
func IsTerminalTaskStatus(status string) bool {
	switch status {
	case TaskStatusCompleted, TaskStatusFailed, TaskStatusCancelled:
		return true
	default:
		return false
	}
}
