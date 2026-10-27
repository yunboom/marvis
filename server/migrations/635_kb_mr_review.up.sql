-- A reviewer's batch of comments on a merge request (decision 107). Comments
-- written in a pending review are visible only to the reviewer until the
-- review is submitted; submitting publishes them all at once.
CREATE TABLE IF NOT EXISTS kb_mr_review (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID NOT NULL,
    merge_request_id UUID NOT NULL,
    reviewer_id      UUID NOT NULL,
    state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'submitted')),
    summary          TEXT NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_at     TIMESTAMPTZ,
    CHECK ((state = 'submitted') = (submitted_at IS NOT NULL))
);

-- The review a comment was written in; NULL for the owner's direct comments.
ALTER TABLE kb_mr_comment ADD COLUMN IF NOT EXISTS review_id UUID;
