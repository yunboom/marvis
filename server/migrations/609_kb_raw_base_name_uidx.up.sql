-- Raw file names are unique per knowledge base and kind.
-- Single statement: a concurrent build cannot share a migration.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS kb_raw_base_name_uidx
    ON kb_raw (knowledge_base_id, kind, name);
