-- Pages past their review date.
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_page_stale_idx
    ON kb_page (knowledge_base_id, stale_after)
    WHERE deleted_at IS NULL;
