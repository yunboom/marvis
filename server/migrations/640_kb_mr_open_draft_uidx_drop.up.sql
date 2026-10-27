-- Superseded by kb_mr_active_draft_uidx (639).
-- Single statement: concurrent index DDL cannot share a migration.
DROP INDEX CONCURRENTLY IF EXISTS kb_mr_open_draft_uidx;
