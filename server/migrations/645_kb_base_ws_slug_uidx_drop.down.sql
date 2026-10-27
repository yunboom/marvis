-- Restore migration 607's index. It fails while a deleted knowledge base and
-- a live one share a slug; remove or rename one of them first.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS kb_base_ws_slug_uidx
    ON kb_base (workspace_id, slug);
