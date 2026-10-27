-- Page history, newest first.
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_revision_page_idx
    ON kb_page_revision (page_id, created_at DESC);
