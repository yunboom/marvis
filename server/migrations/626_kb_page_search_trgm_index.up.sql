-- pg_trgm fallback for keyword search where pg_bigm is unavailable; cmd/migrate
-- skips it where 625 built the bigram index.
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_page_search_trgm
    ON kb_page USING gin (LOWER(search_text) gin_trgm_ops);
