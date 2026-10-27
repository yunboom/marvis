-- Merge request numbers are unique within a workspace.
-- Single statement: a concurrent build cannot share a migration.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS kb_mr_ws_number_uidx
    ON kb_merge_request (workspace_id, number);
