-- Pending annotations of a knowledge base.
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_annotation_base_status_idx
    ON kb_annotation (knowledge_base_id, status);
