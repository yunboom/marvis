-- A job links at most one draft.
-- Single statement: a concurrent build cannot share a migration.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS kb_job_draft_job_id_key
    ON kb_job_draft (job_id);
