-- Knowledge base v2 (migrations 604-628). Enum values such as statuses are
-- passed as parameters from the constants in server/internal/kb.

-- name: ListKbBases :many
SELECT * FROM kb_base
WHERE workspace_id = $1
ORDER BY updated_at DESC, id;

-- name: GetKbBaseByID :one
SELECT * FROM kb_base
WHERE workspace_id = $1 AND id = $2;

-- name: GetKbBaseBySlug :one
SELECT * FROM kb_base
WHERE workspace_id = $1 AND slug = $2;

-- name: CreateKbBase :one
INSERT INTO kb_base (
    workspace_id, name, slug, description, schema_mode, purpose, schema, created_by
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8
) RETURNING *;

-- name: CreateKbConfigRevision :one
INSERT INTO kb_config_revision (
    knowledge_base_id, name, description, schema_mode, purpose, schema, saved_by
) VALUES (
    $1, $2, $3, $4, $5, $6, $7
) RETURNING *;

-- name: CountKbPagesByBase :many
-- Page counts shown on the list exclude reserved pages (quickstart) and
-- deleted pages.
SELECT knowledge_base_id, count(*)::bigint AS page_count
FROM kb_page
WHERE knowledge_base_id = ANY(sqlc.arg('base_ids')::uuid[])
  AND reserved = ''
  AND deleted_at IS NULL
GROUP BY knowledge_base_id;

-- name: CountKbAnnotationsByBase :many
SELECT knowledge_base_id, count(*)::bigint AS annotation_count
FROM kb_annotation
WHERE knowledge_base_id = ANY(sqlc.arg('base_ids')::uuid[])
  AND status = sqlc.arg('status')::text
GROUP BY knowledge_base_id;

-- name: CountKbStalePagesByBase :many
SELECT knowledge_base_id, count(*)::bigint AS stale_count
FROM kb_page
WHERE knowledge_base_id = ANY(sqlc.arg('base_ids')::uuid[])
  AND deleted_at IS NULL
  AND stale_after IS NOT NULL
  AND stale_after < now()
GROUP BY knowledge_base_id;

-- name: CountKbMergeRequestsByBase :many
SELECT knowledge_base_id, count(*)::bigint AS merge_request_count
FROM kb_merge_request
WHERE workspace_id = sqlc.arg('workspace_id')
  AND status = sqlc.arg('status')::text
  AND knowledge_base_id = ANY(sqlc.arg('base_ids')::uuid[])
GROUP BY knowledge_base_id;

-- name: GetKbPage :one
SELECT * FROM kb_page
WHERE knowledge_base_id = $1 AND id = $2;

-- name: ListKbPageBlockIDs :many
-- Every block id in use in a knowledge base, on the mainline and in its
-- drafts, so new block ids stay unique within it.
SELECT (b.value->>'id')::text AS block_id
FROM kb_page p
CROSS JOIN LATERAL jsonb_array_elements(p.blocks) AS b(value)
WHERE p.knowledge_base_id = sqlc.arg('knowledge_base_id')::uuid
UNION
SELECT (b.value->>'id')::text AS block_id
FROM kb_draft d
JOIN kb_draft_page dp ON dp.draft_id = d.id
CROSS JOIN LATERAL jsonb_array_elements(dp.blocks) AS b(value)
WHERE d.knowledge_base_id = sqlc.arg('knowledge_base_id')::uuid;

-- name: ListKbPageTree :many
-- What page paths are built from: every live page of a knowledge base.
SELECT id, parent_id, slug, title FROM kb_page
WHERE knowledge_base_id = $1 AND deleted_at IS NULL;

-- name: CreateKbPage :one
INSERT INTO kb_page (
    id, workspace_id, knowledge_base_id, parent_id, position, slug, reserved,
    type, title, description, frontmatter, blocks, search_text, head_revision_id, stale_after
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
) RETURNING *;

-- name: UpdateKbPageHead :one
-- Moves the mainline of a page to a new revision.
UPDATE kb_page SET
    parent_id = $3,
    position = $4,
    slug = $5,
    type = $6,
    title = $7,
    description = $8,
    frontmatter = $9,
    blocks = $10,
    search_text = $11,
    head_revision_id = $12,
    stale_after = $13,
    deleted_at = $14,
    updated_at = now()
WHERE knowledge_base_id = $1 AND id = $2
RETURNING *;

-- name: CreateKbPageRevision :one
INSERT INTO kb_page_revision (
    id, workspace_id, knowledge_base_id, page_id, prev_revision_id, merge_request_id,
    parent_id, position, slug, frontmatter, blocks, claims, deleted
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
) RETURNING *;

-- name: GetKbPageRevision :one
SELECT * FROM kb_page_revision
WHERE page_id = $1 AND id = $2;

-- name: DeleteKbLinksFromPage :exec
DELETE FROM kb_link
WHERE knowledge_base_id = $1 AND from_page_id = $2;

-- name: CreateKbLinks :exec
-- Batch insert of one page's outgoing links; the arrays are parallel.
INSERT INTO kb_link (
    workspace_id, knowledge_base_id, from_page_id, from_block_id, to_page_id, to_block_id, to_path
)
SELECT
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('knowledge_base_id')::uuid,
    sqlc.arg('from_page_id')::uuid,
    unnest(sqlc.arg('from_block_ids')::text[]),
    unnest(sqlc.arg('to_page_ids')::uuid[]),
    unnest(sqlc.arg('to_block_ids')::text[]),
    unnest(sqlc.arg('to_paths')::text[]);

-- name: ListKbLinksFromPage :many
SELECT * FROM kb_link
WHERE knowledge_base_id = $1 AND from_page_id = $2
ORDER BY from_block_id, to_path;

-- name: GetKbQuickstartPage :one
SELECT * FROM kb_page
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND reserved = sqlc.arg('reserved')::text
  AND deleted_at IS NULL
ORDER BY created_at
LIMIT 1;

-- name: ListKbChildPages :many
-- One page of one tree level, keyset-paginated on (position, id). A NULL
-- parent_id lists the top level. exclude_ids drops pages a draft overlay
-- replaces; the caller merges the draft's version back in.
SELECT id, parent_id, position, slug, reserved, type, title, description, stale_after
FROM kb_page
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND parent_id IS NOT DISTINCT FROM sqlc.narg('parent_id')::uuid
  AND deleted_at IS NULL
  AND reserved = sqlc.arg('reserved')::text
  AND (
    sqlc.narg('after_position')::text IS NULL
    OR (position, id) > (sqlc.narg('after_position')::text, sqlc.arg('after_id')::uuid)
  )
  AND NOT (id = ANY(sqlc.arg('exclude_ids')::uuid[]))
ORDER BY position, id
LIMIT sqlc.arg('row_limit');

-- name: CountKbChildPagesByParent :many
SELECT parent_id, count(*)::bigint AS child_count
FROM kb_page
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND parent_id = ANY(sqlc.arg('parent_ids')::uuid[])
  AND deleted_at IS NULL
GROUP BY parent_id;

-- name: CountKbAnnotationsByPage :many
SELECT page_id, count(*)::bigint AS annotation_count
FROM kb_annotation
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND page_id = ANY(sqlc.arg('page_ids')::uuid[])
  AND status = sqlc.arg('status')::text
GROUP BY page_id;

-- name: CountKbAnnotationsByAuthorType :many
SELECT author_type, count(*)::bigint AS annotation_count
FROM kb_annotation
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND status = sqlc.arg('status')::text
GROUP BY author_type;

-- name: ListKbDraftPages :many
-- Every page a draft touches, with the mainline parent of pages that exist
-- on the mainline (NULL for pages the draft creates).
SELECT
    dp.page_id, dp.op, dp.parent_id, dp.position, dp.slug, dp.frontmatter,
    p.parent_id AS main_parent_id,
    (p.id IS NOT NULL AND p.deleted_at IS NULL)::boolean AS on_mainline,
    COALESCE(p.reserved, '')::text AS main_reserved,
    p.stale_after AS main_stale_after
FROM kb_draft_page dp
LEFT JOIN kb_page p ON p.id = dp.page_id AND p.knowledge_base_id = sqlc.arg('knowledge_base_id')
WHERE dp.draft_id = sqlc.arg('draft_id');

-- name: GetKbDraftPage :one
SELECT * FROM kb_draft_page
WHERE draft_id = $1 AND page_id = $2;

-- name: ListKbClaimsByPage :many
SELECT * FROM kb_claim
WHERE knowledge_base_id = $1 AND page_id = $2
ORDER BY key;

-- name: ListKbBacklinks :many
SELECT DISTINCT p.id, p.title
FROM kb_link l
JOIN kb_page p ON p.id = l.from_page_id
WHERE l.knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND l.to_page_id = sqlc.arg('page_id')
  AND p.id <> sqlc.arg('page_id')
  AND p.deleted_at IS NULL
ORDER BY p.title, p.id;

-- name: GetKbRevisionMergeRequest :one
-- The merge request that produced a revision.
SELECT mr.* FROM kb_page_revision r
JOIN kb_merge_request mr ON mr.id = r.merge_request_id
WHERE r.page_id = $1 AND r.id = $2;

-- name: ListKbOpenMergeRequestsForPage :many
-- Open merge requests whose draft touches the page, newest first.
SELECT mr.number, mr.title
FROM kb_merge_request mr
JOIN kb_draft_page dp ON dp.draft_id = mr.draft_id
WHERE mr.knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND mr.status = sqlc.arg('status')::text
  AND dp.page_id = sqlc.arg('page_id')
ORDER BY mr.updated_at DESC, mr.number DESC;

-- name: ListKbUserDraftsForPage :many
-- The caller's live drafts that change a page, most recently updated first,
-- with where each draft came from: a knowledge base job's chat, or the task
-- (issue or chat) that created it.
SELECT
    d.id, d.title, d.status, d.updated_at,
    dp.op, dp.blocks,
    j.name AS job_name,
    cs.id AS chat_session_id,
    COALESCE(cs.title, '')::text AS chat_title,
    COALESCE(i.number, 0)::int AS issue_number,
    COALESCE(i.title, '')::text AS issue_title
FROM kb_draft d
JOIN kb_draft_page dp ON dp.draft_id = d.id
LEFT JOIN kb_job j ON j.draft_id = d.id
LEFT JOIN agent_task_queue atq ON atq.id = d.task_id
LEFT JOIN issue i ON i.id = atq.issue_id
LEFT JOIN chat_session cs ON cs.id = COALESCE(j.chat_session_id, atq.chat_session_id)
WHERE d.workspace_id = sqlc.arg('workspace_id')
  AND d.knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND d.created_by = sqlc.arg('created_by')
  AND d.status = ANY(sqlc.arg('statuses')::text[])
  AND dp.page_id = sqlc.arg('page_id')
ORDER BY d.updated_at DESC, d.id;

-- name: GetLatestKbMergeRequest :one
SELECT number, title FROM kb_merge_request
WHERE workspace_id = sqlc.arg('workspace_id')
  AND knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND status = sqlc.arg('status')::text
ORDER BY created_at DESC, number DESC
LIMIT 1;

-- name: ListKbRecentMergedPages :many
-- Pages changed by the most recent merges, one row per page (its latest
-- merge), newest merge first. Deleted and reserved pages are left out.
SELECT * FROM (
    SELECT DISTINCT ON (r.page_id)
        r.page_id, p.title, mr.number, mr.title AS mr_title, mr.merged_at
    FROM kb_page_revision r
    JOIN kb_merge_request mr ON mr.id = r.merge_request_id
    JOIN kb_page p ON p.id = r.page_id
    WHERE r.knowledge_base_id = sqlc.arg('knowledge_base_id')
      AND mr.status = sqlc.arg('status')::text
      AND mr.merged_at IS NOT NULL
      AND p.deleted_at IS NULL
      AND p.reserved = sqlc.arg('reserved')::text
    ORDER BY r.page_id, mr.merged_at DESC
) recent
ORDER BY recent.merged_at DESC, recent.page_id
LIMIT sqlc.arg('row_limit');

-- name: CountKbRunningJobs :one
-- Jobs whose chat has an agent turn in flight. Job state is not stored; it
-- is the state of the chat's latest task.
SELECT count(*)::bigint FROM kb_job j
WHERE j.knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND EXISTS (
    SELECT 1 FROM agent_task_queue atq
    WHERE atq.chat_session_id = j.chat_session_id
      AND atq.status = ANY(sqlc.arg('statuses')::text[])
  );

-- name: ListKbPageRevisions :many
-- A page's revisions, newest first, with the merge request that produced each
-- (NULL for the initial revision written at creation).
SELECT
    r.id, r.prev_revision_id, r.blocks, r.deleted, r.created_at,
    mr.number AS mr_number, mr.title AS mr_title, mr.source AS mr_source,
    mr.author_type AS mr_author_type, mr.author_id AS mr_author_id,
    mr.merged_by AS mr_merged_by, mr.merged_at AS mr_merged_at,
    COALESCE(cardinality(mr.annotation_ids), 0)::int AS mr_annotation_count
FROM kb_page_revision r
LEFT JOIN kb_merge_request mr ON mr.id = r.merge_request_id
WHERE r.knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND r.page_id = sqlc.arg('page_id')
ORDER BY r.created_at DESC, r.id DESC;

-- name: ListKbRawByNames :many
SELECT * FROM kb_raw
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND name = ANY(sqlc.arg('names')::text[]);

-- name: ListKbAgentNames :many
SELECT id, name FROM agent
WHERE workspace_id = sqlc.arg('workspace_id')
  AND id = ANY(sqlc.arg('ids')::uuid[]);

-- name: ListKbOwnChatSessionIDs :many
-- The chat sessions among ids the user created; a chat source is openable
-- only for its creator.
SELECT id FROM chat_session
WHERE workspace_id = sqlc.arg('workspace_id')
  AND creator_id = sqlc.arg('creator_id')
  AND id = ANY(sqlc.arg('ids')::uuid[]);

-- name: ListKbIssueNumbers :many
-- Which issue numbers exist in the workspace; a task source is openable when
-- its issue exists.
SELECT number FROM issue
WHERE workspace_id = sqlc.arg('workspace_id')
  AND number = ANY(sqlc.arg('numbers')::int[]);

-- name: GetKbPageInWorkspace :one
SELECT * FROM kb_page
WHERE workspace_id = $1 AND id = $2;

-- name: GetKbDraftInWorkspace :one
SELECT * FROM kb_draft
WHERE workspace_id = $1 AND id = $2;
