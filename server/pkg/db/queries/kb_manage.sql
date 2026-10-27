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
-- Raw files of a deleted knowledge base are not found; their objects stay in
-- storage.
SELECT * FROM kb_raw
WHERE kb_raw.workspace_id = sqlc.arg('workspace_id') AND kb_raw.id = sqlc.arg('id')
  AND EXISTS (SELECT 1 FROM kb_base b WHERE b.id = kb_raw.knowledge_base_id AND b.deleted_at IS NULL);

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

-- name: CloseKbActiveMergeRequestsByBase :many
-- Closes the active merge requests of a knowledge base being deleted and
-- returns their numbers.
UPDATE kb_merge_request SET
    status = sqlc.arg('closed_status'),
    closed_by = sqlc.arg('closed_by'),
    closed_at = now(),
    updated_at = now()
WHERE knowledge_base_id = sqlc.arg('knowledge_base_id')
  AND status = ANY(sqlc.arg('statuses')::text[])
RETURNING number;

-- name: ListWorkspaceKbRawStorageKeys :many
SELECT storage_key FROM kb_raw
WHERE workspace_id = sqlc.arg('workspace_id');

-- name: SoftDeleteKbBase :exec
-- Deleting a knowledge base only marks it: its rows and raw file objects
-- stay, and every read leaves it out. The slug is free again for a new
-- knowledge base (kb_base_ws_slug_live_uidx).
UPDATE kb_base SET
    deleted_at = now(),
    deleted_by = sqlc.arg('deleted_by'),
    updated_at = now()
WHERE id = sqlc.arg('id') AND deleted_at IS NULL;

-- name: GetKbRawByID :one
-- A raw file by id alone, for capability URLs that carry no workspace.
SELECT * FROM kb_raw
WHERE kb_raw.id = sqlc.arg('id')
  AND EXISTS (SELECT 1 FROM kb_base b WHERE b.id = kb_raw.knowledge_base_id AND b.deleted_at IS NULL);
