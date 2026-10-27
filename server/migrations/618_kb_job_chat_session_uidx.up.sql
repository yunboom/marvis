-- A chat session belongs to at most one job.
-- Single statement: a concurrent build cannot share a migration.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS kb_job_chat_session_uidx
    ON kb_job (chat_session_id);
