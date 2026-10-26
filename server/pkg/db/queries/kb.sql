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
-- Every block id in use on the mainline of a knowledge base, so new block ids
-- stay unique within it.
SELECT DISTINCT b->>'id' AS block_id
FROM kb_page p, jsonb_array_elements(p.blocks) AS b
WHERE p.knowledge_base_id = $1;

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
