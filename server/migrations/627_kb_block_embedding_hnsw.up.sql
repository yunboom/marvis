-- Vector search, HNSW with cosine distance. Runs only where the vector
-- extension is installed (see 605).
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_block_embedding_hnsw
    ON kb_block_embedding USING hnsw (embedding vector_cosine_ops);
