-- A knowledge base directory name is unique within its workspace.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS knowledge_base_workspace_slug_uidx
    ON knowledge_base (workspace_id, slug);
