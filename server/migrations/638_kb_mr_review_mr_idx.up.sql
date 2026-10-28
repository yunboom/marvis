-- Reviews of a merge request in submission order.
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_mr_review_mr_idx
    ON kb_mr_review (merge_request_id, submitted_at);
