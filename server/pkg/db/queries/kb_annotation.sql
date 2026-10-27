-- Knowledge base annotations: a note on a sentence, a page or a whole
-- knowledge base (spec 7.6).

-- name: CreateKbAnnotation :one
INSERT INTO kb_annotation (
    workspace_id, knowledge_base_id, page_id, block_id, quote, prefix, suffix,
    body, author_type, author_id
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
) RETURNING *;

-- name: GetKbAnnotationInWorkspace :one
-- Annotations of a deleted knowledge base are not found.
SELECT * FROM kb_annotation
WHERE kb_annotation.workspace_id = $1 AND kb_annotation.id = $2
  AND EXISTS (SELECT 1 FROM kb_base b WHERE b.id = kb_annotation.knowledge_base_id AND b.deleted_at IS NULL);

-- name: GetKbAnnotationForUpdate :one
SELECT * FROM kb_annotation
WHERE kb_annotation.workspace_id = $1 AND kb_annotation.id = $2
  AND EXISTS (SELECT 1 FROM kb_base b WHERE b.id = kb_annotation.knowledge_base_id AND b.deleted_at IS NULL)
FOR UPDATE;

-- name: ListKbAnnotations :many
-- Annotations of a knowledge base, newest first. A NULL status lists every
-- status; base_level_only keeps the annotations on the whole knowledge base.
SELECT * FROM kb_annotation
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND (sqlc.narg('status')::text IS NULL OR status = sqlc.narg('status')::text)
  AND (NOT sqlc.arg('base_level_only')::bool OR page_id IS NULL)
  AND (sqlc.narg('page_id')::uuid IS NULL OR page_id = sqlc.narg('page_id')::uuid)
ORDER BY created_at DESC, id;

-- name: SetKbAnnotationStatus :one
UPDATE kb_annotation SET
    status = sqlc.arg('status'),
    updated_at = now()
WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id')
RETURNING *;

-- name: ListKbMergeRequestNumbers :many
-- Numbers of the merge requests annotations point at.
SELECT id, number FROM kb_merge_request
WHERE workspace_id = sqlc.arg('workspace_id')
  AND id = ANY(sqlc.arg('ids')::uuid[]);

-- name: ListKbAnchoredAnnotations :many
-- Annotations still attached to a sentence on the given pages, locked so a
-- relocation and a concurrent status change do not interleave. Resolved
-- annotations keep the anchor they were resolved with.
SELECT id, page_id, block_id, quote, prefix, suffix, original_quote
FROM kb_annotation
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND page_id = ANY(sqlc.arg('page_ids')::uuid[])
  AND block_id <> ''
  AND status <> sqlc.arg('excluded_status')::text
ORDER BY id
FOR UPDATE;

-- name: UpdateKbAnnotationAnchors :exec
-- Writes relocated anchors in one statement; the arrays are parallel.
UPDATE kb_annotation AS a SET
    block_id = u.block_id,
    quote = u.quote,
    prefix = u.prefix,
    suffix = u.suffix,
    original_quote = u.original_quote
FROM (
    SELECT
        unnest(sqlc.arg('ids')::uuid[]) AS id,
        unnest(sqlc.arg('block_ids')::text[]) AS block_id,
        unnest(sqlc.arg('quotes')::text[]) AS quote,
        unnest(sqlc.arg('prefixes')::text[]) AS prefix,
        unnest(sqlc.arg('suffixes')::text[]) AS suffix,
        unnest(sqlc.arg('original_quotes')::text[]) AS original_quote
) AS u
WHERE a.knowledge_base_id = sqlc.arg('knowledge_base_id') AND a.id = u.id;

-- name: AttachKbAnnotationsToMergeRequest :many
-- Moves the given annotations from one status to another and points them at
-- a merge request; annotations in any other status are left alone.
UPDATE kb_annotation SET
    status = sqlc.arg('to_status'),
    merge_request_id = sqlc.arg('merge_request_id'),
    updated_at = now()
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND id = ANY(sqlc.arg('ids')::uuid[])
  AND status = sqlc.arg('from_status')::text
RETURNING id;

-- name: SettleKbAnnotationsOfMergeRequest :many
-- Moves a merge request's annotations from one status to another. Clearing
-- the merge request puts them back in the queue (the request was closed);
-- keeping it records which merge resolved them.
UPDATE kb_annotation SET
    status = sqlc.arg('to_status'),
    merge_request_id = CASE WHEN sqlc.arg('clear_merge_request')::bool THEN NULL ELSE merge_request_id END,
    updated_at = now()
WHERE merge_request_id = sqlc.arg('merge_request_id')
  AND status = sqlc.arg('from_status')::text
RETURNING id;
