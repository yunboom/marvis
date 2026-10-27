-- Page tree: children of a parent in sibling order.
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_page_parent_idx
    ON kb_page (knowledge_base_id, parent_id, position);
