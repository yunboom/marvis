-- name: GetKnowledgeRepo :one
SELECT * FROM knowledge_repo WHERE workspace_id = $1;

-- name: CreateKnowledgeRepo :one
-- Returns no row when the repository was already registered, so exactly one
-- caller seeds the built-in knowledge base.
INSERT INTO knowledge_repo (workspace_id) VALUES ($1)
ON CONFLICT (workspace_id) DO NOTHING
RETURNING *;

-- name: AllocateKnowledgeChangeNumber :one
UPDATE knowledge_repo SET next_change_number = next_change_number + 1
WHERE workspace_id = $1
RETURNING next_change_number - 1 AS number;

-- name: ListKnowledgeBases :many
SELECT * FROM knowledge_base WHERE workspace_id = $1 ORDER BY created_at, slug;

-- name: GetKnowledgeBase :one
SELECT * FROM knowledge_base WHERE id = $1 AND workspace_id = $2;

-- name: GetKnowledgeBaseBySlug :one
SELECT * FROM knowledge_base WHERE workspace_id = $1 AND slug = $2;

-- name: CreateKnowledgeBase :one
INSERT INTO knowledge_base (workspace_id, name, slug, description, maintainer_agent_id, created_by)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: UpdateKnowledgeBase :one
UPDATE knowledge_base SET
    name = sqlc.arg('name'),
    description = sqlc.arg('description'),
    maintainer_agent_id = sqlc.narg('maintainer_agent_id'),
    updated_at = now()
WHERE id = sqlc.arg('id') AND workspace_id = sqlc.arg('workspace_id')
RETURNING *;

-- name: DeleteKnowledgeBase :exec
DELETE FROM knowledge_base WHERE id = $1 AND workspace_id = $2;

-- name: CountKnowledgeBases :one
SELECT count(*) FROM knowledge_base WHERE workspace_id = $1;

-- name: CountOpenKnowledgeWorkForBase :one
-- What deleting a knowledge base would close: unhandled annotations and open
-- change requests touching its directory.
SELECT
    (SELECT count(*) FROM knowledge_annotation a
      WHERE a.knowledge_base_id = sqlc.arg('knowledge_base_id') AND a.status IN ('pending', 'processing'))::int AS open_annotations,
    (SELECT count(*) FROM knowledge_change_request c
      WHERE c.workspace_id = sqlc.arg('workspace_id') AND sqlc.arg('slug')::text = ANY(c.kb_slugs) AND c.status = 'open')::int AS open_change_requests;

-- name: DismissKnowledgeAnnotationsForBase :exec
UPDATE knowledge_annotation SET status = 'dismissed', updated_at = now()
WHERE knowledge_base_id = $1 AND status IN ('pending', 'processing');

-- name: CloseKnowledgeChangeRequestsForSlug :exec
UPDATE knowledge_change_request SET status = 'closed', updated_at = now()
WHERE workspace_id = $1 AND sqlc.arg('slug')::text = ANY(kb_slugs) AND status = 'open';

-- name: CountKnowledgeAnnotationsByPage :many
-- Open annotations per page of one knowledge base; agent-authored ones are the
-- freshness findings the page header calls out.
SELECT page_path,
       count(*)::int AS open_count,
       (count(*) FILTER (WHERE author_type = 'agent'))::int AS agent_count
FROM knowledge_annotation
WHERE knowledge_base_id = $1 AND status IN ('pending', 'processing')
GROUP BY page_path;

-- name: ListKnowledgeChatSources :many
-- Display data for chat:// citations. Only the owner may open a session, so the
-- handler decides per row whether to expose the session id.
SELECT cs.id, cs.creator_id, cs.created_at, u.name AS creator_name, a.name AS agent_name
FROM chat_session cs
JOIN "user" u ON u.id = cs.creator_id
JOIN agent a ON a.id = cs.agent_id
WHERE cs.workspace_id = $1 AND cs.id = ANY(sqlc.arg('ids')::uuid[]);

-- name: ListKnowledgeGaps :many
SELECT * FROM knowledge_gap
WHERE workspace_id = $1 AND (sqlc.narg('status')::text IS NULL OR status = sqlc.narg('status')::text)
ORDER BY created_at DESC
LIMIT 200;

-- name: FindOpenKnowledgeGap :one
SELECT * FROM knowledge_gap
WHERE workspace_id = $1 AND lower(question) = lower(sqlc.arg('question')::text) AND status IN ('open', 'processing')
LIMIT 1;

-- name: CreateKnowledgeGap :one
INSERT INTO knowledge_gap (workspace_id, question, source, created_by_type, created_by_id)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: CreateKnowledgeChangeRequest :one
INSERT INTO knowledge_change_request (
    workspace_id, number, title, source, author_type, author_id, branch, base_commit, head_commit,
    conflict, conflict_files, summary, risk, chat_session_id, annotation_ids, kb_slugs
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
)
RETURNING *;

-- name: GetKnowledgeChangeRequest :one
SELECT * FROM knowledge_change_request WHERE workspace_id = $1 AND number = $2;

-- name: GetOpenKnowledgeChangeRequestByBranch :one
SELECT * FROM knowledge_change_request WHERE workspace_id = $1 AND branch = $2 AND status = 'open';

-- name: ListKnowledgeChangeRequests :many
SELECT * FROM knowledge_change_request
WHERE workspace_id = $1 AND (sqlc.narg('status')::text IS NULL OR status = sqlc.narg('status')::text)
ORDER BY number DESC
LIMIT 200;

-- name: CountOpenKnowledgeChangeRequests :one
SELECT count(*)::int FROM knowledge_change_request WHERE workspace_id = $1 AND status = 'open';

-- name: RefreshKnowledgeChangeRequest :one
UPDATE knowledge_change_request SET
    title = sqlc.arg('title'),
    summary = sqlc.arg('summary'),
    risk = sqlc.arg('risk'),
    base_commit = sqlc.arg('base_commit'),
    head_commit = sqlc.arg('head_commit'),
    conflict = sqlc.arg('conflict'),
    conflict_files = sqlc.arg('conflict_files'),
    kb_slugs = sqlc.arg('kb_slugs'),
    annotation_ids = sqlc.arg('annotation_ids'),
    updated_at = now()
WHERE id = sqlc.arg('id') AND status = 'open'
RETURNING *;

-- name: MarkKnowledgeChangeRequestMerged :one
UPDATE knowledge_change_request SET
    status = 'merged', merge_commit = $2, merged_by = $3, merged_at = now(), conflict = FALSE, conflict_files = '{}', updated_at = now()
WHERE id = $1 AND status = 'open'
RETURNING *;

-- name: MarkKnowledgeChangeRequestConflict :exec
UPDATE knowledge_change_request SET conflict = TRUE, conflict_files = $2, updated_at = now()
WHERE id = $1 AND status = 'open';

-- name: CloseKnowledgeChangeRequest :one
UPDATE knowledge_change_request SET status = 'closed', updated_at = now()
WHERE id = $1 AND status = 'open'
RETURNING *;

-- name: ListMergedKnowledgeChangeRequests :many
SELECT * FROM knowledge_change_request
WHERE workspace_id = $1 AND status = 'merged'
ORDER BY merged_at DESC
LIMIT $2;

-- name: CreateKnowledgeChangeComment :one
INSERT INTO knowledge_change_comment (change_request_id, path, line, author_type, author_id, body)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: ListKnowledgeChangeComments :many
SELECT * FROM knowledge_change_comment WHERE change_request_id = $1 ORDER BY created_at;

-- name: SetKnowledgeAnnotationsStatusForChange :exec
-- Moves the annotations a change request handles in one statement: to
-- processing when it opens, resolved when it merges, back to pending (and
-- unlinked) when it closes.
UPDATE knowledge_annotation SET
    status = sqlc.arg('status'),
    change_request_id = sqlc.narg('change_request_id'),
    updated_at = now()
WHERE workspace_id = sqlc.arg('workspace_id') AND id = ANY(sqlc.arg('ids')::uuid[]);

-- name: CreateKnowledgeAnnotation :one
INSERT INTO knowledge_annotation (workspace_id, knowledge_base_id, page_path, quote, prefix, suffix, body, author_type, author_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING *;

-- name: ListKnowledgeAnnotations :many
SELECT * FROM knowledge_annotation
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND (sqlc.narg('status')::text IS NULL OR status = sqlc.narg('status')::text)
  AND (sqlc.narg('page_path')::text IS NULL OR page_path = sqlc.narg('page_path')::text)
ORDER BY created_at DESC
LIMIT 500;

-- name: ListKnowledgeAnnotationsByIDs :many
SELECT * FROM knowledge_annotation WHERE workspace_id = $1 AND id = ANY(sqlc.arg('ids')::uuid[]);

-- name: GetKnowledgeAnnotation :one
SELECT * FROM knowledge_annotation WHERE id = $1 AND workspace_id = $2;

-- name: UpdateKnowledgeAnnotationStatus :one
UPDATE knowledge_annotation SET status = sqlc.arg('status'), updated_at = now()
WHERE id = sqlc.arg('id') AND workspace_id = sqlc.arg('workspace_id')
RETURNING *;

-- name: CreateKnowledgeSession :one
INSERT INTO knowledge_session (chat_session_id, workspace_id, carrier_agent_id, knowledge_base_id, kind, created_by)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: GetKnowledgeSession :one
SELECT * FROM knowledge_session WHERE chat_session_id = $1 AND workspace_id = $2;

-- name: SetKnowledgeBaseMaintainerIfUnset :exec
UPDATE knowledge_base SET maintainer_agent_id = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2 AND maintainer_agent_id IS NULL;

-- name: ListKnowledgeActorNames :many
-- Display names for authors that are either members or agents, in one round trip.
SELECT u.id, u.name FROM "user" u WHERE u.id = ANY(sqlc.arg('user_ids')::uuid[])
UNION ALL
SELECT a.id, a.name FROM agent a WHERE a.id = ANY(sqlc.arg('agent_ids')::uuid[]);

-- name: UpdateKnowledgeGapStatus :one
UPDATE knowledge_gap SET status = sqlc.arg('status'), updated_at = now()
WHERE id = sqlc.arg('id') AND workspace_id = sqlc.arg('workspace_id')
RETURNING *;

-- name: GetAutopilotBySystemKey :one
SELECT * FROM autopilot
WHERE workspace_id = sqlc.arg('workspace_id') AND system_key = sqlc.arg('system_key');

-- name: SetAutopilotSystemKey :exec
UPDATE autopilot SET system_key = sqlc.arg('system_key') WHERE id = sqlc.arg('id');

-- name: PauseSystemAutopilot :exec
-- Pauses a platform-owned autopilot with a reason the UI explains (e.g. the last
-- knowledge base was deleted). Archived rows stay archived.
UPDATE autopilot SET status = 'paused', pause_reason = sqlc.arg('pause_reason'), updated_at = now()
WHERE workspace_id = sqlc.arg('workspace_id') AND system_key = sqlc.arg('system_key') AND status = 'active';

-- name: GetLastCompletedAutopilotRunAt :one
-- Start of the latest completed run; the digest reads sources from there on.
SELECT COALESCE(max(triggered_at), 'epoch'::timestamptz)::timestamptz AS triggered_at
FROM autopilot_run
WHERE autopilot_id = sqlc.arg('autopilot_id') AND status = 'completed';

-- name: ListKnowledgeSourceIssues :many
-- Issues created or updated in [since, until), oldest first, for the daily digest.
SELECT i.id, i.number, i.title, i.status, COALESCE(i.description, '')::text AS description, i.updated_at, w.issue_prefix
FROM issue i
JOIN workspace w ON w.id = i.workspace_id
WHERE i.workspace_id = sqlc.arg('workspace_id')
  AND i.updated_at >= sqlc.arg('since') AND i.updated_at < sqlc.arg('until')
ORDER BY i.updated_at, i.id
LIMIT sqlc.arg('max_rows');

-- name: ListKnowledgeSourceComments :many
-- Comments written in [since, until), oldest first. System and status rows are noise for the digest.
SELECT c.id, c.content, c.author_type, c.created_at, i.number, w.issue_prefix,
       COALESCE(u.name, a.name, '')::text AS author_name
FROM comment c
JOIN issue i ON i.id = c.issue_id
JOIN workspace w ON w.id = i.workspace_id
LEFT JOIN "user" u ON c.author_type = 'member' AND u.id = c.author_id
LEFT JOIN agent a ON c.author_type = 'agent' AND a.id = c.author_id
WHERE i.workspace_id = sqlc.arg('workspace_id') AND c.type = 'comment'
  AND c.created_at >= sqlc.arg('since') AND c.created_at < sqlc.arg('until')
ORDER BY c.created_at, c.id
LIMIT sqlc.arg('max_rows');

-- name: ListKnowledgeSourceChatMessages :many
-- Chat messages in [since, until) from sessions the given user created with a regular
-- (kind = 'user') agent. Other people's chats and hidden system sessions never appear.
SELECT m.id, m.chat_session_id, m.role, m.content, m.created_at, cs.title AS session_title, a.name AS agent_name
FROM chat_message m
JOIN chat_session cs ON cs.id = m.chat_session_id
JOIN agent a ON a.id = cs.agent_id
WHERE cs.workspace_id = sqlc.arg('workspace_id') AND cs.creator_id = sqlc.arg('user_id')
  AND a.kind = 'user' AND m.message_kind = 'message'
  AND m.created_at >= sqlc.arg('since') AND m.created_at < sqlc.arg('until')
ORDER BY m.created_at, m.id
LIMIT sqlc.arg('max_rows');
