-- Live sibling pages have distinct slugs; top-level pages share the zero parent.
-- Single statement: a concurrent build cannot share a migration.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS kb_page_sibling_slug_uidx
    ON kb_page (knowledge_base_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), slug)
    WHERE deleted_at IS NULL;
