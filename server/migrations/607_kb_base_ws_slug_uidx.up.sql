-- Knowledge base slugs are unique within a workspace; also serves the list query.
-- Single statement: a concurrent build cannot share a migration.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS kb_base_ws_slug_uidx
    ON kb_base (workspace_id, slug);
