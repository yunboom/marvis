-- A chat session belongs to at most one run; also serves the reverse lookup
-- from a chat session to its run.
-- Single statement: a concurrent build cannot share a migration.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS autopilot_run_chat_session_uidx
    ON autopilot_run (chat_session_id)
    WHERE chat_session_id IS NOT NULL;
