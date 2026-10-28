-- A submitted review moves a merge request to changes_requested until its
-- owner asks for review again (decision 107). review_requested_at marks that
-- moment, so reviews submitted after it are the ones still to be resolved.
ALTER TABLE kb_merge_request DROP CONSTRAINT IF EXISTS kb_merge_request_status_check;
ALTER TABLE kb_merge_request ADD CONSTRAINT kb_merge_request_status_check
    CHECK (status IN ('open', 'changes_requested', 'merged', 'closed'));
ALTER TABLE kb_merge_request ADD COLUMN IF NOT EXISTS review_requested_at TIMESTAMPTZ;
