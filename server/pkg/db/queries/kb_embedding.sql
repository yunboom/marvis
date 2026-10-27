-- kb_block_embedding exists only where pgvector is installed (migration 606):
-- callers check KbBlockEmbeddingTableExists before running these.

-- name: ListKbPagesForEmbedding :many
-- Pages to (re)index, deleted ones included so their vectors can go.
SELECT id, workspace_id, knowledge_base_id, blocks, deleted_at
FROM kb_page
WHERE id = ANY(sqlc.arg('page_ids')::uuid[]);

-- name: ListKbBlockEmbeddingHashes :many
SELECT page_id, block_id, content_hash, model
FROM kb_block_embedding
WHERE page_id = ANY(sqlc.arg('page_ids')::uuid[]);

-- name: UpsertKbBlockEmbeddings :exec
-- Vectors arrive in pgvector's text form, one row per array position.
INSERT INTO kb_block_embedding (page_id, block_id, knowledge_base_id, workspace_id, content_hash, model, embedding, updated_at)
SELECT r.page_id, r.block_id, r.knowledge_base_id, r.workspace_id, r.content_hash, sqlc.arg('model')::text, r.embedding::vector, now()
FROM (
    SELECT
        unnest(sqlc.arg('page_ids')::uuid[]) AS page_id,
        unnest(sqlc.arg('block_ids')::text[]) AS block_id,
        unnest(sqlc.arg('knowledge_base_ids')::uuid[]) AS knowledge_base_id,
        unnest(sqlc.arg('workspace_ids')::uuid[]) AS workspace_id,
        unnest(sqlc.arg('content_hashes')::text[]) AS content_hash,
        unnest(sqlc.arg('embeddings')::text[]) AS embedding
) AS r
ON CONFLICT (page_id, block_id) DO UPDATE SET
    knowledge_base_id = EXCLUDED.knowledge_base_id,
    workspace_id = EXCLUDED.workspace_id,
    content_hash = EXCLUDED.content_hash,
    model = EXCLUDED.model,
    embedding = EXCLUDED.embedding,
    updated_at = EXCLUDED.updated_at;

-- name: DeleteKbBlockEmbeddings :exec
-- Drops the vectors of blocks that are gone, one (page, block) per position.
DELETE FROM kb_block_embedding e
USING (
    SELECT
        unnest(sqlc.arg('page_ids')::uuid[]) AS page_id,
        unnest(sqlc.arg('block_ids')::text[]) AS block_id
) AS r
WHERE e.page_id = r.page_id AND e.block_id = r.block_id;

-- name: TouchKbBlockEmbeddings :exec
-- Marks the pages as indexed at now(), so the backfill skips them until the
-- page changes again.
UPDATE kb_block_embedding SET updated_at = now()
WHERE page_id = ANY(sqlc.arg('page_ids')::uuid[]);

-- name: DeleteKbBlockEmbeddingsOfDeletedPages :exec
DELETE FROM kb_block_embedding e
USING kb_page p
WHERE e.page_id = p.id AND p.deleted_at IS NOT NULL;

-- name: ListKbPagesNeedingEmbedding :many
-- Live pages, after a keyset cursor, without vectors of the current model or
-- changed since they were indexed. Pages without any text to embed come back
-- on every pass; indexing them is a no-op.
SELECT p.id
FROM kb_page p
WHERE p.id > sqlc.arg('after_id')::uuid
  AND p.deleted_at IS NULL
  AND (
    NOT EXISTS (
        SELECT 1 FROM kb_block_embedding e
        WHERE e.page_id = p.id AND e.model = sqlc.arg('model')::text
    )
    OR EXISTS (
        SELECT 1 FROM kb_block_embedding e
        WHERE e.page_id = p.id AND (e.model <> sqlc.arg('model')::text OR e.updated_at < p.updated_at)
    )
  )
ORDER BY p.id
LIMIT sqlc.arg('row_limit');

-- name: SearchKbBlockEmbeddings :many
-- The vector half of hybrid search: nearest blocks by cosine distance. Run in
-- a transaction after SET LOCAL hnsw.iterative_scan = relaxed_order; the
-- materialized CTE restores strict ordering (pgvector README, "Iterative
-- Index Scans"; "+ 0" is its form for Postgres before 17).
WITH nearest AS MATERIALIZED (
    SELECT e.page_id, e.block_id, (e.embedding <=> sqlc.arg('query')::text::vector) AS distance
    FROM kb_block_embedding e
    JOIN kb_page p ON p.id = e.page_id
    WHERE e.workspace_id = sqlc.arg('workspace_id')
      AND e.model = sqlc.arg('model')::text
      AND (sqlc.narg('knowledge_base_id')::uuid IS NULL OR e.knowledge_base_id = sqlc.narg('knowledge_base_id')::uuid)
      AND p.deleted_at IS NULL
      AND (sqlc.narg('page_type')::text IS NULL OR lower(p.type) = lower(sqlc.narg('page_type')::text))
    ORDER BY distance
    LIMIT sqlc.arg('row_limit')
)
SELECT page_id, block_id, distance::float8 AS distance
FROM nearest
WHERE distance <= sqlc.arg('max_distance')::float8
ORDER BY distance + 0;

-- name: ListKbPageIDsMatchingSearch :many
-- Which of the given pages the keyword half matches, for the hybrid total.
SELECT p.id
FROM kb_page p
WHERE p.id = ANY(sqlc.arg('page_ids')::uuid[])
  AND p.deleted_at IS NULL
  AND lower(p.search_text) LIKE ALL (sqlc.arg('patterns')::text[]);

-- name: ListKbPagesForSearchHits :many
-- Pages the vector half found that the keyword half did not return.
SELECT p.id, p.knowledge_base_id, b.slug AS kb_slug, p.title, p.type, p.blocks
FROM kb_page p
JOIN kb_base b ON b.id = p.knowledge_base_id
WHERE p.id = ANY(sqlc.arg('page_ids')::uuid[]) AND p.deleted_at IS NULL;
