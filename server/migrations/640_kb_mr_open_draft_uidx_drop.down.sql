-- Restore migration 622's index.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS kb_mr_open_draft_uidx
    ON kb_merge_request (draft_id)
    WHERE status = 'open';
