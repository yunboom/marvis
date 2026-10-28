-- A draft has at most one merge request under review, open or waiting on
-- its owner (changes_requested). Replaces kb_mr_open_draft_uidx (640).
-- Single statement: a concurrent build cannot share a migration.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS kb_mr_active_draft_uidx
    ON kb_merge_request (draft_id)
    WHERE status IN ('open', 'changes_requested');
