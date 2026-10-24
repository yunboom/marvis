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

-- name: UpdateKnowledgeGapStatus :one
UPDATE knowledge_gap SET status = sqlc.arg('status'), updated_at = now()
WHERE id = sqlc.arg('id') AND workspace_id = sqlc.arg('workspace_id')
RETURNING *;
