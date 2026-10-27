-- Keyword search over pages, CJK-friendly. cmd/migrate runs this only where
-- pg_bigm is installed; elsewhere 626 builds the pg_trgm fallback (same shape
-- as the issue search indexes, migrations 032 / 138).
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_page_search_bigm
    ON kb_page USING gin (LOWER(search_text) gin_bigm_ops);
