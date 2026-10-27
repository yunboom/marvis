-- A draft has at most one open merge request.
-- Single statement: a concurrent build cannot share a migration.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS kb_mr_open_draft_uidx
    ON kb_merge_request (draft_id)
    WHERE status = 'open';
