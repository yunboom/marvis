-- Knowledge base v2 (migrations 604-630). Enum values such as statuses are
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
-- Page counts shown on the list exclude deleted pages.
SELECT knowledge_base_id, count(*)::bigint AS page_count
FROM kb_page
WHERE knowledge_base_id = ANY(sqlc.arg('base_ids')::uuid[])
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
    id, workspace_id, knowledge_base_id, parent_id, position, slug,
    type, title, description, frontmatter, blocks, search_text, head_revision_id, stale_after
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
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

-- name: ListKbChildPages :many
-- One page of one tree level, keyset-paginated on (position, id). A NULL
-- parent_id lists the top level. exclude_ids drops pages a draft overlay
-- replaces; the caller merges the draft's version back in.
SELECT id, parent_id, position, slug, type, title, description, stale_after
FROM kb_page
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND parent_id IS NOT DISTINCT FROM sqlc.narg('parent_id')::uuid
  AND deleted_at IS NULL
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
LEFT JOIN kb_job_draft jd ON jd.draft_id = d.id
LEFT JOIN kb_job j ON j.id = jd.job_id
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
-- merge), newest merge first. Deleted pages are left out.
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

-- name: GetKbBaseForUpdate :one
-- Locks a knowledge base for a configuration save so the stale-config check
-- and the update are one step.
SELECT * FROM kb_base
WHERE workspace_id = $1 AND id = $2
FOR UPDATE;

-- name: UpdateKbBaseConfig :one
UPDATE kb_base
SET name = sqlc.arg('name'),
    description = sqlc.arg('description'),
    schema_mode = sqlc.arg('schema_mode'),
    purpose = sqlc.arg('purpose'),
    schema = sqlc.arg('schema'),
    updated_at = now()
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: CreateKbBuilderSession :one
-- The builder's own row beside its chat session (mirrors agent_builder_draft):
-- what the conversation creates or configures, and the right-hand draft.
INSERT INTO kb_builder_session (chat_session_id, workspace_id, mode, knowledge_base_id)
VALUES (sqlc.arg('chat_session_id'), sqlc.arg('workspace_id'), sqlc.arg('mode'), sqlc.narg('knowledge_base_id'))
RETURNING *;

-- name: GetKbBuilderSession :one
SELECT * FROM kb_builder_session
WHERE chat_session_id = $1;

-- name: UpdateKbBuilderDraft :one
-- Whole-object last write wins: one editor on one screen autosaves the full
-- configuration. Callers hold LockChatSessionForDraftWrite.
UPDATE kb_builder_session
SET draft = sqlc.arg('draft'),
    updated_at = now()
WHERE chat_session_id = sqlc.arg('chat_session_id')
RETURNING *;

-- name: DeleteKbBuilderSession :exec
-- kb_builder_session has no chat_session FK (repo rule), so every path that
-- removes a conversation says so explicitly.
DELETE FROM kb_builder_session WHERE chat_session_id = $1;

-- name: DeleteKbBuilderSessionsBySystemRuntimeAgents :exec
-- A runtime teardown hard-deletes its system carriers and their sessions
-- cascade away; prune the builder rows first, while the join still resolves.
DELETE FROM kb_builder_session
WHERE chat_session_id IN (
    SELECT cs.id FROM chat_session cs
    JOIN agent a ON a.id = cs.agent_id
    WHERE a.runtime_id = $1 AND a.kind = 'system'
);

-- name: ListKbBuilderSessionsByCreator :many
-- The caller's unfinished builder conversations, newest activity first. Same
-- rules as ListAgentBuilderSessionsByCreator: active sessions holding a
-- message or a saved draft. The runtime is the carrier's, not
-- chat_session.runtime_id (the daemon's resume pointer, stale after a switch).
SELECT cs.id,
       cs.title,
       a.runtime_id,
       s.mode,
       s.knowledge_base_id,
       s.draft,
       s.updated_at,
       COALESCE(lm.content, '')::text AS last_message_content,
       COALESCE(lm.role, '')::text AS last_message_role,
       lm.created_at AS last_message_at
FROM kb_builder_session s
JOIN chat_session cs ON cs.id = s.chat_session_id
JOIN agent a ON a.id = cs.agent_id
LEFT JOIN LATERAL (
  SELECT content, role, created_at
    FROM chat_message m
   WHERE m.chat_session_id = cs.id
   ORDER BY m.created_at DESC
   LIMIT 1
) lm ON true
WHERE s.workspace_id = sqlc.arg('workspace_id')
  AND cs.creator_id = sqlc.arg('creator_id')
  AND cs.status = 'active'
  AND (sqlc.narg('mode')::text IS NULL OR s.mode = sqlc.narg('mode')::text)
  AND (sqlc.narg('knowledge_base_id')::uuid IS NULL OR s.knowledge_base_id = sqlc.narg('knowledge_base_id')::uuid)
  AND (lm.created_at IS NOT NULL OR s.draft <> '{}'::jsonb)
ORDER BY COALESCE(lm.created_at, s.updated_at) DESC;

-- name: GetKbDraftForUpdate :one
-- Locks a draft so its writes run one at a time.
SELECT * FROM kb_draft
WHERE workspace_id = $1 AND id = $2
FOR UPDATE;

-- name: CreateKbDraft :one
INSERT INTO kb_draft (workspace_id, knowledge_base_id, title, created_by, task_id)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: BumpKbDraftVersion :one
UPDATE kb_draft SET version = version + 1, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: UpsertKbDraftPage :exec
INSERT INTO kb_draft_page (
    draft_id, page_id, op, base_revision_id, parent_id, position, slug,
    frontmatter, blocks, claims, conflicts, version, updated_at
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now()
)
ON CONFLICT (draft_id, page_id) DO UPDATE SET
    op = EXCLUDED.op,
    base_revision_id = EXCLUDED.base_revision_id,
    parent_id = EXCLUDED.parent_id,
    position = EXCLUDED.position,
    slug = EXCLUDED.slug,
    frontmatter = EXCLUDED.frontmatter,
    blocks = EXCLUDED.blocks,
    claims = EXCLUDED.claims,
    conflicts = EXCLUDED.conflicts,
    version = EXCLUDED.version,
    updated_at = now();

-- name: DeleteKbDraftPage :exec
DELETE FROM kb_draft_page
WHERE draft_id = $1 AND page_id = $2;

-- name: ListKbDraftPageRows :many
SELECT * FROM kb_draft_page
WHERE draft_id = $1
ORDER BY page_id;

-- name: ListKbPagesByIDs :many
SELECT * FROM kb_page
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND id = ANY(sqlc.arg('ids')::uuid[]);

-- name: ListKbPageRevisionsByIDs :many
SELECT * FROM kb_page_revision
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND id = ANY(sqlc.arg('ids')::uuid[]);

-- name: CountKbInboundLinks :many
-- Mainline pages linking to each page, not counting the page itself and the
-- pages a draft rewrites (their links are counted from the draft copy).
SELECT to_page_id, count(DISTINCT from_page_id)::bigint AS link_count
FROM kb_link
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND to_page_id = ANY(sqlc.arg('page_ids')::uuid[])
  AND from_page_id <> to_page_id
  AND NOT (from_page_id = ANY(sqlc.arg('exclude_ids')::uuid[]))
GROUP BY to_page_id;

-- name: ListKbClaimsByEvidence :many
-- Claims of live pages, optionally only those citing an evidence uri prefix
-- or checked before a time.
SELECT c.* FROM kb_claim c
JOIN kb_page p ON p.id = c.page_id AND p.deleted_at IS NULL
WHERE c.knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND (
    sqlc.narg('evidence')::text IS NULL
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(c.evidence) AS e(value)
      WHERE starts_with(e.value->>'uri', sqlc.narg('evidence')::text)
    )
  )
  AND (sqlc.narg('checked_before')::timestamptz IS NULL OR c.checked_at < sqlc.narg('checked_before')::timestamptz)
ORDER BY c.page_id, c.key
LIMIT sqlc.arg('row_limit') OFFSET sqlc.arg('row_offset');

-- name: SearchKbPages :many
-- Keyword search over titles and body text: every pattern must match.
-- Title hits rank first.
SELECT p.id, p.knowledge_base_id, b.slug AS kb_slug, p.title, p.type, p.blocks
FROM kb_page p
JOIN kb_base b ON b.id = p.knowledge_base_id
WHERE p.workspace_id = sqlc.arg('workspace_id')
  AND p.deleted_at IS NULL
  AND (sqlc.narg('knowledge_base_id')::uuid IS NULL OR p.knowledge_base_id = sqlc.narg('knowledge_base_id')::uuid)
  AND (sqlc.narg('page_type')::text IS NULL OR lower(p.type) = lower(sqlc.narg('page_type')::text))
  AND lower(p.search_text) LIKE ALL (sqlc.arg('patterns')::text[])
ORDER BY (lower(p.title) LIKE ANY (sqlc.arg('patterns')::text[])) DESC, p.updated_at DESC, p.id
LIMIT sqlc.arg('row_limit') OFFSET sqlc.arg('row_offset');

-- name: ListKbStalePages :many
SELECT p.id, p.title, p.stale_after,
    (SELECT count(*) FROM kb_claim c WHERE c.page_id = p.id)::bigint AS claim_count
FROM kb_page p
WHERE p.knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND p.deleted_at IS NULL
  AND p.stale_after IS NOT NULL
  AND p.stale_after < now()
ORDER BY p.stale_after, p.id
LIMIT sqlc.arg('row_limit') OFFSET sqlc.arg('row_offset');

-- name: GetKbJobForUpdate :one
-- Locks a job so two drafts cannot be linked to it at once.
SELECT * FROM kb_job
WHERE workspace_id = $1 AND id = $2
FOR UPDATE;

-- name: GetKbJobDraftByJob :one
SELECT * FROM kb_job_draft
WHERE job_id = $1;

-- name: CreateKbJobDraft :one
INSERT INTO kb_job_draft (workspace_id, job_id, draft_id, created_by)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: ListKbWorkspaceChatSessions :many
-- Every member's public chat sessions, for owners reading chats to ingest
-- (scope=workspace); hidden system carriers are left out.
SELECT cs.id, cs.workspace_id, cs.agent_id, cs.creator_id, cs.project_id, cs.title, cs.status,
    cs.pinned_at, cs.created_at, cs.updated_at,
    COALESCE(lm.content, '')::text AS last_message_content,
    COALESCE(lm.role, '')::text AS last_message_role,
    lm.created_at AS last_message_at
FROM chat_session cs
JOIN agent a ON a.id = cs.agent_id AND a.kind <> 'system'
JOIN LATERAL (
  SELECT content, role, created_at
    FROM chat_message m
   WHERE m.chat_session_id = cs.id
     AND m.message_kind != 'channel_command'
   ORDER BY m.created_at DESC
   LIMIT 1
) lm ON true
WHERE cs.workspace_id = sqlc.arg('workspace_id')
  AND cs.status = 'active'
  AND (sqlc.narg('since')::timestamptz IS NULL OR lm.created_at > sqlc.narg('since')::timestamptz)
  AND (sqlc.narg('agent_id')::uuid IS NULL OR cs.agent_id = sqlc.narg('agent_id')::uuid)
ORDER BY lm.created_at DESC, cs.id
LIMIT sqlc.arg('row_limit') OFFSET sqlc.arg('row_offset');
