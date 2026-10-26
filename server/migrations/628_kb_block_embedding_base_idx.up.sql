-- Embeddings of a knowledge base. Runs only where the vector extension is
-- installed (see 605).
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_block_embedding_base_idx
    ON kb_block_embedding (knowledge_base_id);
