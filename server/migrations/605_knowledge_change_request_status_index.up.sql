-- Serves the review queue (change requests per workspace by status).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_knowledge_change_request_status
    ON knowledge_change_request (workspace_id, status, number DESC);
