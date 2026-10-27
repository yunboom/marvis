-- Knowledge base management: raw files, export, graph and deletion.

-- name: CreateKbRaws :many
-- Batch insert of one upload's raw files; the arrays are parallel.
INSERT INTO kb_raw (
    id, workspace_id, knowledge_base_id, kind, name, storage_key, size, content_type, uploaded_by
)
SELECT
    unnest(sqlc.arg('ids')::uuid[]),
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('knowledge_base_id')::uuid,
    sqlc.arg('kind')::text,
    unnest(sqlc.arg('names')::text[]),
    unnest(sqlc.arg('storage_keys')::text[]),
    unnest(sqlc.arg('sizes')::bigint[]),
    unnest(sqlc.arg('content_types')::text[]),
    sqlc.arg('uploaded_by')::uuid
RETURNING *;

-- name: ListKbRawNamesTaken :many
-- The names among names a knowledge base already holds for one kind.
SELECT name FROM kb_raw
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND kind = sqlc.arg('kind')
  AND name = ANY(sqlc.arg('names')::text[]);

-- name: ListKbRaws :many
-- Raw files of a knowledge base with their uploader's name, newest first;
-- kind NULL lists every kind.
SELECT r.*, COALESCE(u.name, '')::text AS uploaded_by_name
FROM kb_raw r
LEFT JOIN "user" u ON u.id = r.uploaded_by
WHERE r.knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND (sqlc.narg('kind')::text IS NULL OR r.kind = sqlc.narg('kind')::text)
ORDER BY r.created_at DESC, r.id;

-- name: GetKbRawInWorkspace :one
SELECT * FROM kb_raw
WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: ListKbRawCitations :many
-- Which live pages cite which raw:// uris in their claims' evidence.
SELECT DISTINCT c.page_id, (e.value->>'uri')::text AS uri
FROM kb_claim c
JOIN kb_page p ON p.id = c.page_id AND p.deleted_at IS NULL
CROSS JOIN LATERAL jsonb_array_elements(c.evidence) AS e(value)
WHERE c.knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND starts_with(e.value->>'uri', 'raw://');

-- name: ListKbLivePagesAfter :many
-- One batch of a knowledge base's live pages in id order, for the export.
SELECT * FROM kb_page
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND deleted_at IS NULL
  AND id > sqlc.arg('after_id')::uuid
ORDER BY id
LIMIT sqlc.arg('row_limit');

-- name: ListKbExportTree :many
-- The live page tree of a knowledge base with what generated index files
-- list.
SELECT id, parent_id, position, slug, title, description FROM kb_page
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id') AND deleted_at IS NULL;

-- name: ListKbLinkedBlocks :many
-- The blocks of live pages that mainline links point at, with their content
-- (an export anchors headings by text and other blocks by ^id).
SELECT DISTINCT l.to_page_id, l.to_block_id, (b.value->>'content')::text AS content
FROM kb_link l
JOIN kb_page p ON p.id = l.to_page_id AND p.deleted_at IS NULL
CROSS JOIN LATERAL jsonb_array_elements(p.blocks) AS b(value)
WHERE l.knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND l.to_block_id <> ''
  AND b.value->>'id' = l.to_block_id;

-- name: ListKbClaimsByPages :many
SELECT * FROM kb_claim
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND page_id = ANY(sqlc.arg('page_ids')::uuid[])
ORDER BY page_id, key;

-- name: ListKbGraphLinks :many
-- Mainline links between live pages and to pages not yet written. Links to
-- deleted pages and self links are left out.
SELECT DISTINCT l.from_page_id, l.to_page_id, l.to_path
FROM kb_link l
JOIN kb_page f ON f.id = l.from_page_id AND f.deleted_at IS NULL
LEFT JOIN kb_page t ON t.id = l.to_page_id
WHERE l.knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND (l.to_page_id IS NULL OR (t.deleted_at IS NULL AND t.id IS NOT NULL AND l.to_page_id <> l.from_page_id));

-- name: ListKbOpenMergeRequestNumbers :many
SELECT number FROM kb_merge_request
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND status = ANY(sqlc.arg('statuses')::text[])
ORDER BY number;

-- name: ListKbRawStorageKeys :many
SELECT storage_key FROM kb_raw
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id');

-- name: ListWorkspaceKbRawStorageKeys :many
SELECT storage_key FROM kb_raw
WHERE workspace_id = sqlc.arg('workspace_id');

-- name: DeleteKbBlockEmbeddingsByBase :exec
DELETE FROM kb_block_embedding
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id');

-- name: DeleteKnowledgeBase :exec
-- Removes a knowledge base and every row that belongs to it. The tables carry
-- no foreign keys; child tables without knowledge_base_id go through their
-- parent before the parent rows are removed. kb_block_embedding is optional
-- (migration 606) and swept separately.
WITH deleted_kb_config_revisions AS (
    DELETE FROM kb_config_revision WHERE kb_config_revision.knowledge_base_id = sqlc.arg('knowledge_base_id')
),
deleted_kb_builder_sessions AS (
    DELETE FROM kb_builder_session WHERE kb_builder_session.knowledge_base_id = sqlc.arg('knowledge_base_id')
),
deleted_kb_raws AS (
    DELETE FROM kb_raw WHERE kb_raw.knowledge_base_id = sqlc.arg('knowledge_base_id')
),
deleted_kb_pages AS (
    DELETE FROM kb_page WHERE kb_page.knowledge_base_id = sqlc.arg('knowledge_base_id')
),
deleted_kb_page_revisions AS (
    DELETE FROM kb_page_revision WHERE kb_page_revision.knowledge_base_id = sqlc.arg('knowledge_base_id')
),
deleted_kb_claims AS (
    DELETE FROM kb_claim WHERE kb_claim.knowledge_base_id = sqlc.arg('knowledge_base_id')
),
deleted_kb_links AS (
    DELETE FROM kb_link WHERE kb_link.knowledge_base_id = sqlc.arg('knowledge_base_id')
),
deleted_kb_draft_pages AS (
    DELETE FROM kb_draft_page
    USING kb_draft
    WHERE kb_draft_page.draft_id = kb_draft.id
      AND kb_draft.knowledge_base_id = sqlc.arg('knowledge_base_id')
),
deleted_kb_drafts AS (
    DELETE FROM kb_draft WHERE kb_draft.knowledge_base_id = sqlc.arg('knowledge_base_id')
),
deleted_kb_job_drafts AS (
    DELETE FROM kb_job_draft
    USING kb_job
    WHERE kb_job_draft.job_id = kb_job.id
      AND kb_job.knowledge_base_id = sqlc.arg('knowledge_base_id')
),
deleted_kb_jobs AS (
    DELETE FROM kb_job WHERE kb_job.knowledge_base_id = sqlc.arg('knowledge_base_id')
),
deleted_kb_annotations AS (
    DELETE FROM kb_annotation WHERE kb_annotation.knowledge_base_id = sqlc.arg('knowledge_base_id')
),
deleted_kb_mr_comments AS (
    DELETE FROM kb_mr_comment
    USING kb_merge_request
    WHERE kb_mr_comment.merge_request_id = kb_merge_request.id
      AND kb_merge_request.knowledge_base_id = sqlc.arg('knowledge_base_id')
),
deleted_kb_mr_reviews AS (
    DELETE FROM kb_mr_review
    USING kb_merge_request
    WHERE kb_mr_review.merge_request_id = kb_merge_request.id
      AND kb_merge_request.knowledge_base_id = sqlc.arg('knowledge_base_id')
),
deleted_kb_mr_events AS (
    DELETE FROM kb_mr_event
    USING kb_merge_request
    WHERE kb_mr_event.merge_request_id = kb_merge_request.id
      AND kb_merge_request.knowledge_base_id = sqlc.arg('knowledge_base_id')
),
deleted_kb_merge_requests AS (
    DELETE FROM kb_merge_request WHERE kb_merge_request.knowledge_base_id = sqlc.arg('knowledge_base_id')
)
DELETE FROM kb_base
WHERE kb_base.id = sqlc.arg('knowledge_base_id');

-- name: GetKbRawByID :one
-- A raw file by id alone, for capability URLs that carry no workspace.
SELECT * FROM kb_raw WHERE id = sqlc.arg('id');
