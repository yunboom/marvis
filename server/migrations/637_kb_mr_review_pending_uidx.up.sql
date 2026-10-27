-- A reviewer has at most one pending review per merge request.
-- Single statement: a concurrent build cannot share a migration.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS kb_mr_review_pending_uidx
    ON kb_mr_review (merge_request_id, reviewer_id)
    WHERE state = 'pending';
