-- Serves the annotation queue of one knowledge base filtered by status.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_knowledge_annotation_base
    ON knowledge_annotation (knowledge_base_id, status, created_at DESC);
