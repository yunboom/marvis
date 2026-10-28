-- Superseded by kb_base_ws_slug_live_uidx (644).
-- Single statement: concurrent index DDL cannot share a migration.
DROP INDEX CONCURRENTLY IF EXISTS kb_base_ws_slug_uidx;
