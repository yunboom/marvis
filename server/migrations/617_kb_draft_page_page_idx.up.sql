-- Open drafts touching a page.
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_draft_page_page_idx
    ON kb_draft_page (page_id);
