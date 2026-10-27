ALTER TABLE kb_merge_request DROP COLUMN IF EXISTS review_requested_at;
UPDATE kb_merge_request SET status = 'open' WHERE status = 'changes_requested';
ALTER TABLE kb_merge_request DROP CONSTRAINT IF EXISTS kb_merge_request_status_check;
ALTER TABLE kb_merge_request ADD CONSTRAINT kb_merge_request_status_check
    CHECK (status IN ('open', 'merged', 'closed'));
