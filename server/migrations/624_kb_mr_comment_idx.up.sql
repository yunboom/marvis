-- Review comments of a merge request in order.
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_mr_comment_idx
    ON kb_mr_comment (merge_request_id, created_at);
