-- A draft belongs to at most one job.
-- Single statement: a concurrent build cannot share a migration.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS kb_job_draft_draft_id_key
    ON kb_job_draft (draft_id);
