-- Slugs are unique among the live knowledge bases of a workspace, so a
-- deleted knowledge base frees its slug; also serves the list query.
-- Single statement: a concurrent build cannot share a migration.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS kb_base_ws_slug_live_uidx
    ON kb_base (workspace_id, slug)
    WHERE deleted_at IS NULL;
