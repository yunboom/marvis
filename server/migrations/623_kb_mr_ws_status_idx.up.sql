-- Merge request list by status.
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_mr_ws_status_idx
    ON kb_merge_request (workspace_id, status, updated_at DESC);
