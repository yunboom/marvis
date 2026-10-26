-- Claims citing a given source.
-- Single statement: a concurrent build cannot share a migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_claim_evidence_gin
    ON kb_claim USING GIN (evidence jsonb_path_ops);
