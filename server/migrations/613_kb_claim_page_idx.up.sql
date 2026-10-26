-- Claims of a page.
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_claim_page_idx
    ON kb_claim (page_id);
