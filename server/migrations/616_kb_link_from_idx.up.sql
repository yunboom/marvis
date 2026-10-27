-- Outgoing links of a page; rewritten on every merge.
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_link_from_idx
    ON kb_link (from_page_id);
