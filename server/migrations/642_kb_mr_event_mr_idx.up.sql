-- Events of a merge request in order, for its timeline.
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_mr_event_mr_idx
    ON kb_mr_event (merge_request_id, created_at);
