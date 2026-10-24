-- Serves loading the comments of one change request.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_knowledge_change_comment_request
    ON knowledge_change_comment (change_request_id, created_at);
