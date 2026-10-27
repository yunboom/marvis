package inbox

// Inbox categories (decision 108): the tabs the inbox groups notifications
// by. Every notification is also listed under "all", which is no category.
const (
	// CategoryIssue holds the notifications about issues.
	CategoryIssue = "issue"
	// CategoryKb holds the knowledge base notifications.
	CategoryKb = "kb"
	// CategoryAutopilot holds the autopilot notifications.
	CategoryAutopilot = "autopilot"
)

// categoryTypes lists the notification types of each category. It mirrors
// INBOX_CATEGORY_OF in packages/core/inbox/category.ts; a type in neither
// list shows only under "all".
var categoryTypes = map[string][]string{
	CategoryIssue: {
		"issue_assigned", "issue_subscribed", "unassigned", "assignee_changed",
		"status_changed", "priority_changed", "start_date_changed", "due_date_changed",
		"new_comment", "mentioned", "review_requested", "task_completed", "task_failed",
		"agent_blocked", "agent_completed", "reaction_added", "children_done",
		"quick_create_done", "quick_create_failed", "quick_create_unconfirmed",
	},
	CategoryKb:        {"kb_mr_changes_requested", "kb_mr_review_requested", "kb_mr_review_needed"},
	CategoryAutopilot: {"autopilot_paused", "autopilot_quota_exceeded"},
}

// CategoryTypes returns the notification types of a category; ok is false for
// an unknown category. The empty category is "all": no types, no narrowing.
func CategoryTypes(category string) (types []string, ok bool) {
	if category == "" {
		return []string{}, true
	}
	types, ok = categoryTypes[category]

	return types, ok
}
