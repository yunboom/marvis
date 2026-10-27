-- Job list of a knowledge base, newest first.
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_job_base_created_idx
    ON kb_job (knowledge_base_id, created_at DESC);
