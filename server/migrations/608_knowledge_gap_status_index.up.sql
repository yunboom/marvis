-- Serves the knowledge gap list per workspace.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_knowledge_gap_status
    ON knowledge_gap (workspace_id, status, created_at DESC);
