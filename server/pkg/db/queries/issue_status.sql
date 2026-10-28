-- Issue status catalog (MUL-6243). Each workspace holds the 7 built-in
-- statuses plus custom ones, all stored in four lifecycle categories.

-- name: SeedIssueStatusEntries :exec
-- Idempotent seed of the 7 built-ins. Safe to call concurrently from multiple
-- pods during a rolling deploy: the unique (workspace_id, key) index makes a
-- losing racer a no-op rather than an error. Initial positions are 0; the list's
-- built-in tiebreak preserves the seed order until an admin reorders the group.
INSERT INTO issue_status (workspace_id, key, name, description, category, status_group, color, is_system, position)
VALUES
    (sqlc.arg('workspace_id')::uuid, 'backlog', 'Backlog', 'Parked. Assigning an issue here never starts an agent run.', 'unstarted', 'not_started', '#6b7280', TRUE, 0),
    (sqlc.arg('workspace_id')::uuid, 'todo', 'Todo', 'Queued for work. Moving an issue here starts the assigned agent.', 'unstarted', 'not_started', '#6b7280', TRUE, 0),
    (sqlc.arg('workspace_id')::uuid, 'in_progress', 'In Progress', 'Actively being worked on.', 'started', 'working', '#f59e0b', TRUE, 0),
    (sqlc.arg('workspace_id')::uuid, 'in_review', 'In Review', 'Work delivered, waiting on human review. Finalizes the autopilot run.', 'started', 'needs_attention', '#22c55e', TRUE, 0),
    (sqlc.arg('workspace_id')::uuid, 'done', 'Done', 'Completed.', 'done', 'ended', '#3b82f6', TRUE, 0),
    (sqlc.arg('workspace_id')::uuid, 'blocked', 'Blocked', 'Stalled on an external dependency.', 'started', 'needs_attention', '#ef4444', TRUE, 0),
    (sqlc.arg('workspace_id')::uuid, 'cancelled', 'Cancelled', 'Decided not to do.', 'closed', 'ended', '#6b7280', TRUE, 0)
ON CONFLICT DO NOTHING;

-- name: ListIssueStatusEntries :many
-- Position orders both built-in and custom rows inside each lifecycle group.
-- Built-in order is only a tiebreak for the original seeded positions.
SELECT * FROM issue_status
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND (sqlc.arg('include_archived')::bool OR archived_at IS NULL)
ORDER BY
    CASE category WHEN 'unstarted' THEN 0 WHEN 'started' THEN 1 WHEN 'done' THEN 2 WHEN 'closed' THEN 3 ELSE 4 END,
    position,
	CASE WHEN is_system THEN 0 ELSE 1 END,
	CASE key
		WHEN 'backlog' THEN 0
		WHEN 'todo' THEN 1
		WHEN 'in_progress' THEN 2
		WHEN 'in_review' THEN 3
		WHEN 'blocked' THEN 4
		WHEN 'done' THEN 5
		WHEN 'cancelled' THEN 6
		ELSE 7
	END,
    key;

-- name: GetIssueStatusEntryByKey :one
SELECT * FROM issue_status
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND key = sqlc.arg('key')::text;

-- name: GetIssueStatusEntryByID :one
SELECT * FROM issue_status
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: CreateIssueStatusEntry :one
-- Custom statuses only: is_system is never set here, so the canonical-key and
-- non-archivable CHECK constraints can only ever apply to seeded rows. An empty
-- status_group takes the category default from issue_status_fill_group.
INSERT INTO issue_status (workspace_id, key, name, description, category, status_group, color, icon, position)
VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('key')::text,
    sqlc.arg('name')::text,
    sqlc.arg('description')::text,
    sqlc.arg('category')::text,
    NULLIF(sqlc.arg('status_group')::text, ''),
    sqlc.arg('color')::text,
    sqlc.arg('icon')::text,
    COALESCE(
        (SELECT MAX(position) + 1 FROM issue_status
         WHERE workspace_id = sqlc.arg('workspace_id')::uuid
		   AND category = sqlc.arg('category')::text),
        0
    )
)
RETURNING *;

-- name: UpdateIssueStatusEntry :one
-- key and category are absent on purpose: both are immutable after create.
-- The is_system guard is what enforces "built-in name and color are locked" at
-- the storage layer, so a handler bug cannot rename a built-in. status_group
-- only moves between working and needs_attention; the group CHECK rejects any
-- other pairing with the row's category.
UPDATE issue_status SET
    name = COALESCE(sqlc.narg('name'), name),
    status_group = COALESCE(sqlc.narg('status_group'), status_group),
    description = COALESCE(sqlc.narg('description'), description),
    color = COALESCE(sqlc.narg('color'), color),
    icon = COALESCE(sqlc.narg('icon'), icon),
    position = COALESCE(sqlc.narg('position'), position),
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND is_system = FALSE
  AND archived_at IS NULL
RETURNING *;

-- name: ArchiveIssueStatusEntry :one
-- Built-ins are excluded by is_system: archiving one would delete its
-- category's behavior definition.
--
-- Archiving retires a status from future use only. Issues already on it keep
-- it — Effective ignores archived_at, so their behavior is unchanged — while
-- Resolve rejects it, so nothing new can be assigned to it.
UPDATE issue_status SET
    archived_at = now(),
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND is_system = FALSE
  AND archived_at IS NULL
RETURNING *;

-- name: CountIssuesUsingStatusKey :one
-- Archive precondition, including terminal issues. Call under the catalog lock
-- so a concurrent status assignment cannot invalidate the empty check.
SELECT COUNT(*)::bigint FROM issue
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND status = sqlc.arg('key')::text;

-- name: ListIssueStatusKeyReferences :many
-- Every place a status key is persisted, live configuration and history alike.
-- Rows store the key as text, never the status id, so a deleted row whose key
-- is still referenced would leave that reference unresolvable — and free the
-- key for a later status to inherit the old reference. Deletion is therefore
-- allowed only when this returns nothing. Call under the catalog lock.
--
-- activity_log and inbox_item have no index on the status fields; this is a
-- rare admin action, and each EXISTS stops at the first match.
SELECT ref::text FROM (
    SELECT 'issue' AS ref WHERE EXISTS (
        SELECT 1 FROM issue
        WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND status = sqlc.arg('key')::text)
    UNION ALL
    SELECT 'workflow' WHERE EXISTS (
        SELECT 1 FROM issue_workflow w
        WHERE w.workspace_id = sqlc.arg('workspace_id')::uuid
          AND (w.initial_status_key = sqlc.arg('key')::text OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(w.steps) AS step
              WHERE sqlc.arg('key')::text IN (step->>'status_key', step->>'next_status_key', step->>'back_status_key'))))
    UNION ALL
    SELECT 'pr_merge_setting' WHERE EXISTS (
        SELECT 1 FROM workspace
        WHERE id = sqlc.arg('workspace_id')::uuid AND settings->>'pr_merge_status' = sqlc.arg('key')::text)
    UNION ALL
    SELECT 'saved_view' WHERE EXISTS (
        SELECT 1 FROM issue_view
        WHERE workspace_id = sqlc.arg('workspace_id')::uuid
          AND query->'statusFilters' @> jsonb_build_array(sqlc.arg('key')::text))
    UNION ALL
    SELECT 'wakeup' WHERE EXISTS (
        SELECT 1 FROM issue_wakeup
        WHERE workspace_id = sqlc.arg('workspace_id')::uuid
          AND ((condition->>'type' = 'issue_field' AND condition->>'field' = 'status'
                AND condition->>'value' = sqlc.arg('key')::text)
               OR condition_state IN ('status:' || sqlc.arg('key')::text, 'issue:' || sqlc.arg('key')::text)))
    UNION ALL
    SELECT 'wakeup_receipt' WHERE EXISTS (
        SELECT 1 FROM issue_wakeup_receipt r
        JOIN issue_wakeup w ON w.id = r.wakeup_id
        WHERE w.workspace_id = sqlc.arg('workspace_id')::uuid
          AND jsonb_path_exists(r.payload, '$.** ? (@.status == $k || @.previous_status == $k)',
                                jsonb_build_object('k', sqlc.arg('key')::text)))
    UNION ALL
    SELECT 'agent_task' WHERE EXISTS (
        SELECT 1 FROM agent_task_queue t
        JOIN issue i ON i.id = t.issue_id
        WHERE i.workspace_id = sqlc.arg('workspace_id')::uuid AND t.workflow_step = sqlc.arg('key')::text)
    UNION ALL
    SELECT 'activity' WHERE EXISTS (
        SELECT 1 FROM activity_log
        WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND action = 'status_changed'
          AND sqlc.arg('key')::text IN (details->>'from', details->>'to'))
    UNION ALL
    SELECT 'inbox' WHERE EXISTS (
        SELECT 1 FROM inbox_item
        WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND type = 'status_changed'
          AND sqlc.arg('key')::text IN (details->>'from', details->>'to'))
) AS refs;

-- name: DeleteArchivedIssueStatusEntry :execrows
-- Only an archived custom status: archiving already guaranteed no issue sits on
-- it and no workflow lists it, and an archived status cannot gain new history.
DELETE FROM issue_status
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND is_system = false
  AND archived_at IS NOT NULL;

-- name: DeleteIssueStatusEntriesForWorkspace :exec
-- No foreign keys by project rule, so workspace teardown cleans up here.
DELETE FROM issue_status WHERE workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: LockIssueStatusCatalog :exec
-- EXCLUSIVE transaction lock over a workspace's status catalog, held by archive
-- so no issue can be written onto a status between the in-use census and the
-- archive itself. pg_advisory_xact_lock (not pg_try_) so a concurrent archive
-- queues instead of failing.
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg('workspace_id')::uuid::text || ':issue_status', 0));

-- name: LockIssueStatusCatalogShared :exec
-- SHARED counterpart, taken by a write that puts an issue ON a custom status.
-- Shared holders do not block each other, so concurrent issue writes keep their
-- current throughput; they only block against archive's exclusive lock.
--
-- Built-in statuses deliberately do NOT take this lock: a built-in can never be
-- archived (enforced by issue_status_system_not_archivable), so there is nothing
-- to race with, and the overwhelmingly common write path stays lock-free.
SELECT pg_advisory_xact_lock_shared(hashtextextended(sqlc.arg('workspace_id')::uuid::text || ':issue_status', 0));

-- name: ListIssueStatusKeysByCategories :many
-- Expands a set of categories to the status keys that belong to them, so a
-- category filter can be applied as an INDEXED `status = ANY(...)` predicate
-- instead of wrapping the column in issue_effective_status(), which makes
-- (workspace_id, status) unusable and forces a full workspace scan.
--
-- ARCHIVED statuses are included on purpose: archiving retires a status from
-- future assignment but leaves existing issues on it, and those issues must
-- still appear in their category's column.
SELECT key FROM issue_status
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND category = ANY(sqlc.arg('categories')::text[]);

-- name: ListActiveCustomIssueStatusEntries :many
-- One category's ACTIVE custom statuses — the exact set a reorder must cover.
-- Read inside the reorder transaction, under the catalog lock, so a status
-- archived concurrently cannot slip in or out between validation and write.
SELECT * FROM issue_status
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND category = sqlc.arg('category')::text
  AND is_system = FALSE
  AND archived_at IS NULL
ORDER BY position, key;

-- name: ReorderIssueStatusEntries :execrows
-- Atomic intra-category reorder. One statement, so a failure leaves the whole
-- order untouched instead of the partially-applied prefix a per-row PATCH loop
-- produces.
--
-- Full-catalog callers may reorder built-ins, without changing their semantics.
-- Legacy custom-only callers preserve the positions occupied by custom rows.
-- Archived rows remain frozen.
UPDATE issue_status s
SET position = (sqlc.arg('positions')::float8[])[v.ordinality],
    updated_at = now()
FROM unnest(sqlc.arg('ids')::uuid[]) WITH ORDINALITY AS v(id, ordinality)
WHERE s.id = v.id
  AND s.workspace_id = sqlc.arg('workspace_id')::uuid
  AND (sqlc.arg('include_system')::bool OR s.is_system = FALSE)
  AND s.archived_at IS NULL;
