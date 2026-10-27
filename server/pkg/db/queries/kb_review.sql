-- name: GetKbMergeRequestByNumber :one
SELECT * FROM kb_merge_request
WHERE workspace_id = sqlc.arg('workspace_id') AND number = sqlc.arg('number');

-- name: GetKbMergeRequestInWorkspace :one
SELECT * FROM kb_merge_request
WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: GetKbMergeRequestForUpdate :one
SELECT * FROM kb_merge_request
WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id')
FOR UPDATE;

-- name: ListKbMergeRequests :many
-- Merge requests of a workspace, optionally of one knowledge base, most
-- recently updated first. Merged ones sort by merge time (the change log).
SELECT * FROM kb_merge_request
WHERE workspace_id = sqlc.arg('workspace_id')
  AND status = ANY(sqlc.arg('statuses')::text[])
  AND (sqlc.narg('knowledge_base_id')::uuid IS NULL OR knowledge_base_id = sqlc.narg('knowledge_base_id')::uuid)
ORDER BY COALESCE(merged_at, updated_at) DESC, number DESC
LIMIT sqlc.arg('row_limit') OFFSET sqlc.arg('row_offset');

-- name: CountKbMergeRequestsByStatus :many
-- Per-status counts for the review list tabs.
SELECT status, count(*)::bigint AS merge_request_count
FROM kb_merge_request
WHERE workspace_id = sqlc.arg('workspace_id')
  AND (sqlc.narg('knowledge_base_id')::uuid IS NULL OR knowledge_base_id = sqlc.narg('knowledge_base_id')::uuid)
GROUP BY status;

-- name: ListKbMergeRequestsByIDs :many
SELECT * FROM kb_merge_request
WHERE workspace_id = sqlc.arg('workspace_id')
  AND id = ANY(sqlc.arg('ids')::uuid[]);

-- name: SetKbMergeRequestMerged :one
UPDATE kb_merge_request SET
    status = sqlc.arg('status'),
    merged_by = sqlc.arg('merged_by'),
    merged_at = now(),
    updated_at = now()
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: SetKbMergeRequestClosed :one
UPDATE kb_merge_request SET
    status = sqlc.arg('status'),
    closed_by = sqlc.arg('closed_by'),
    closed_at = now(),
    close_reason = sqlc.arg('close_reason'),
    updated_at = now()
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: UpdateKbMergeRequestText :one
UPDATE kb_merge_request SET
    title = sqlc.arg('title'),
    summary = sqlc.arg('summary'),
    risk = sqlc.arg('risk'),
    updated_at = now()
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: ListKbDraftsByIDs :many
SELECT * FROM kb_draft
WHERE workspace_id = sqlc.arg('workspace_id')
  AND id = ANY(sqlc.arg('ids')::uuid[]);

-- name: ListKbMergeRequestOrigins :many
-- Where each draft came from (spec 7.13): the knowledge base job it is linked
-- to, else the task that created it, through which chat, issue or autopilot
-- run that task ran.
SELECT
    d.id AS draft_id,
    j.id AS job_id,
    COALESCE(j.name, '')::text AS job_name,
    j.created_by AS job_created_by,
    j.agent_id AS job_agent_id,
    j.chat_session_id AS job_chat_session_id,
    atq.agent_id AS task_agent_id,
    atq.chat_session_id AS task_chat_session_id,
    COALESCE(cs.title, '')::text AS chat_title,
    cs.creator_id AS chat_creator_id,
    atq.issue_id AS task_issue_id,
    COALESCE(i.title, '')::text AS issue_title,
    COALESCE(i.number, 0)::int AS issue_number,
    atq.autopilot_run_id AS task_autopilot_run_id,
    ar.autopilot_id AS autopilot_id,
    COALESCE(ap.title, '')::text AS autopilot_title
FROM kb_draft d
LEFT JOIN kb_job_draft jd ON jd.draft_id = d.id
LEFT JOIN kb_job j ON j.id = jd.job_id
LEFT JOIN agent_task_queue atq ON atq.id = d.task_id
LEFT JOIN chat_session cs ON cs.id = atq.chat_session_id
LEFT JOIN issue i ON i.id = atq.issue_id
LEFT JOIN autopilot_run ar ON ar.id = atq.autopilot_run_id
LEFT JOIN autopilot ap ON ap.id = ar.autopilot_id
WHERE d.workspace_id = sqlc.arg('workspace_id')
  AND d.id = ANY(sqlc.arg('draft_ids')::uuid[]);

-- name: LockKbPagesByIDs :many
-- Locks the mainline pages a merge writes, in page id order so concurrent
-- merges of overlapping drafts cannot deadlock.
SELECT * FROM kb_page
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND id = ANY(sqlc.arg('ids')::uuid[])
ORDER BY id
FOR UPDATE;

-- name: CreateKbPageRevisions :exec
-- Batch insert of merged revisions; the arrays are parallel.
INSERT INTO kb_page_revision (
    id, workspace_id, knowledge_base_id, page_id, prev_revision_id, merge_request_id,
    parent_id, position, slug, frontmatter, blocks, claims, deleted
)
SELECT
    u.id, sqlc.arg('workspace_id')::uuid, sqlc.arg('knowledge_base_id')::uuid, u.page_id,
    u.prev_revision_id, sqlc.arg('merge_request_id')::uuid,
    u.parent_id, u.position, u.slug, u.frontmatter, u.blocks, u.claims, u.deleted
FROM (
    SELECT
        unnest(sqlc.arg('ids')::uuid[]) AS id,
        unnest(sqlc.arg('page_ids')::uuid[]) AS page_id,
        unnest(sqlc.arg('prev_revision_ids')::uuid[]) AS prev_revision_id,
        unnest(sqlc.arg('parent_ids')::uuid[]) AS parent_id,
        unnest(sqlc.arg('positions')::text[]) AS position,
        unnest(sqlc.arg('slugs')::text[]) AS slug,
        unnest(sqlc.arg('frontmatters')::jsonb[]) AS frontmatter,
        unnest(sqlc.arg('blocks')::jsonb[]) AS blocks,
        unnest(sqlc.arg('claims')::jsonb[]) AS claims,
        unnest(sqlc.arg('deleted')::boolean[]) AS deleted
) AS u;

-- name: UpsertKbPages :exec
-- Moves merged pages to their new head revisions, creating the pages the
-- merge adds; the arrays are parallel.
INSERT INTO kb_page (
    id, workspace_id, knowledge_base_id, parent_id, position, slug, type, title, description,
    frontmatter, blocks, search_text, head_revision_id, stale_after, deleted_at
)
SELECT
    u.id, sqlc.arg('workspace_id')::uuid, sqlc.arg('knowledge_base_id')::uuid, u.parent_id,
    u.position, u.slug, u.type, u.title, u.description, u.frontmatter, u.blocks, u.search_text,
    u.head_revision_id, u.stale_after, CASE WHEN u.deleted THEN now() END
FROM (
    SELECT
        unnest(sqlc.arg('ids')::uuid[]) AS id,
        unnest(sqlc.arg('parent_ids')::uuid[]) AS parent_id,
        unnest(sqlc.arg('positions')::text[]) AS position,
        unnest(sqlc.arg('slugs')::text[]) AS slug,
        unnest(sqlc.arg('types')::text[]) AS type,
        unnest(sqlc.arg('titles')::text[]) AS title,
        unnest(sqlc.arg('descriptions')::text[]) AS description,
        unnest(sqlc.arg('frontmatters')::jsonb[]) AS frontmatter,
        unnest(sqlc.arg('blocks')::jsonb[]) AS blocks,
        unnest(sqlc.arg('search_texts')::text[]) AS search_text,
        unnest(sqlc.arg('head_revision_ids')::uuid[]) AS head_revision_id,
        unnest(sqlc.arg('stale_afters')::timestamptz[]) AS stale_after,
        unnest(sqlc.arg('deleted')::boolean[]) AS deleted
) AS u
ON CONFLICT (id) DO UPDATE SET
    parent_id = EXCLUDED.parent_id,
    position = EXCLUDED.position,
    slug = EXCLUDED.slug,
    type = EXCLUDED.type,
    title = EXCLUDED.title,
    description = EXCLUDED.description,
    frontmatter = EXCLUDED.frontmatter,
    blocks = EXCLUDED.blocks,
    search_text = EXCLUDED.search_text,
    head_revision_id = EXCLUDED.head_revision_id,
    stale_after = EXCLUDED.stale_after,
    deleted_at = CASE WHEN EXCLUDED.deleted_at IS NULL THEN NULL ELSE COALESCE(kb_page.deleted_at, EXCLUDED.deleted_at) END,
    updated_at = now();

-- name: DeleteKbLinksFromPages :exec
DELETE FROM kb_link
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND from_page_id = ANY(sqlc.arg('page_ids')::uuid[]);

-- name: CreateKbLinksOfPages :exec
-- Batch insert of the outgoing links of several pages; the arrays are parallel.
INSERT INTO kb_link (
    workspace_id, knowledge_base_id, from_page_id, from_block_id, to_page_id, to_block_id, to_path
)
SELECT
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('knowledge_base_id')::uuid,
    unnest(sqlc.arg('from_page_ids')::uuid[]),
    unnest(sqlc.arg('from_block_ids')::text[]),
    unnest(sqlc.arg('to_page_ids')::uuid[]),
    unnest(sqlc.arg('to_block_ids')::text[]),
    unnest(sqlc.arg('to_paths')::text[]);

-- name: ResolveKbDanglingLinks :exec
-- Points links written to a path that had no page yet at the page now there.
UPDATE kb_link AS l SET to_page_id = u.page_id
FROM (
    SELECT
        unnest(sqlc.arg('paths')::text[]) AS path,
        unnest(sqlc.arg('page_ids')::uuid[]) AS page_id
) AS u
WHERE l.knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND l.to_page_id IS NULL
  AND l.to_path = u.path;

-- name: DeleteKbClaimsOfPages :exec
DELETE FROM kb_claim
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND page_id = ANY(sqlc.arg('page_ids')::uuid[]);

-- name: CreateKbClaims :exec
-- Batch insert of mainline claims; the arrays are parallel.
INSERT INTO kb_claim (
    workspace_id, knowledge_base_id, page_id, block_id, key, text, evidence, checked_at
)
SELECT
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('knowledge_base_id')::uuid,
    unnest(sqlc.arg('page_ids')::uuid[]),
    unnest(sqlc.arg('block_ids')::text[]),
    unnest(sqlc.arg('keys')::text[]),
    unnest(sqlc.arg('texts')::text[]),
    unnest(sqlc.arg('evidence')::jsonb[]),
    unnest(sqlc.arg('checked_ats')::timestamptz[]);

-- name: BumpKbContentVersion :exec
UPDATE kb_base SET content_version = content_version + 1, updated_at = now()
WHERE id = sqlc.arg('id');

-- name: ListKbRevisionsByMergeRequest :many
-- The revisions a merge request wrote, one per page.
SELECT * FROM kb_page_revision
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND merge_request_id = sqlc.arg('merge_request_id')
ORDER BY page_id;

-- name: CreateKbDraftPages :exec
-- Batch insert of draft pages; the arrays are parallel.
INSERT INTO kb_draft_page (
    draft_id, page_id, op, base_revision_id, parent_id, position, slug,
    frontmatter, blocks, claims, conflicts, version, updated_at
)
SELECT
    sqlc.arg('draft_id')::uuid, u.page_id, u.op, u.base_revision_id, u.parent_id, u.position, u.slug,
    u.frontmatter, u.blocks, u.claims, '[]'::jsonb, sqlc.arg('version')::bigint, now()
FROM (
    SELECT
        unnest(sqlc.arg('page_ids')::uuid[]) AS page_id,
        unnest(sqlc.arg('ops')::text[]) AS op,
        unnest(sqlc.arg('base_revision_ids')::uuid[]) AS base_revision_id,
        unnest(sqlc.arg('parent_ids')::uuid[]) AS parent_id,
        unnest(sqlc.arg('positions')::text[]) AS position,
        unnest(sqlc.arg('slugs')::text[]) AS slug,
        unnest(sqlc.arg('frontmatters')::jsonb[]) AS frontmatter,
        unnest(sqlc.arg('blocks')::jsonb[]) AS blocks,
        unnest(sqlc.arg('claims')::jsonb[]) AS claims
) AS u;

-- name: CreateKbMrComment :one
INSERT INTO kb_mr_comment (
    merge_request_id, parent_id, quote_page_id, quote_block_id, quote_text, body, author_type, author_id
) VALUES (
    sqlc.arg('merge_request_id'), sqlc.narg('parent_id'), sqlc.narg('quote_page_id'), sqlc.arg('quote_block_id'),
    sqlc.arg('quote_text'), sqlc.arg('body'), sqlc.arg('author_type'), sqlc.arg('author_id')
)
RETURNING *;

-- name: SetKbMrCommentTriggered :one
UPDATE kb_mr_comment SET triggered = sqlc.arg('triggered')
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: GetKbMrComment :one
SELECT * FROM kb_mr_comment
WHERE merge_request_id = sqlc.arg('merge_request_id') AND id = sqlc.arg('id');

-- name: ListKbMrComments :many
SELECT * FROM kb_mr_comment
WHERE merge_request_id = sqlc.arg('merge_request_id')
ORDER BY created_at, id;

-- name: ListKbTaskStatuses :many
SELECT id, status FROM agent_task_queue
WHERE id = ANY(sqlc.arg('ids')::uuid[]);

-- name: ListKbChatSessionsByIDs :many
SELECT * FROM chat_session
WHERE workspace_id = sqlc.arg('workspace_id')
  AND id = ANY(sqlc.arg('ids')::uuid[]);

-- name: ListKbAgentsByIDs :many
SELECT * FROM agent
WHERE workspace_id = sqlc.arg('workspace_id')
  AND id = ANY(sqlc.arg('ids')::uuid[]);
