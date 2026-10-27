-- Backlinks of a page.
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_link_to_idx
    ON kb_link (to_page_id);
