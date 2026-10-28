-- What happened to a merge request (decision 107): reviews submitted, review
-- requested again, merged, closed, reverted, edited. The review page's
-- timeline merges these with the comments. payload carries the kind's facts.
CREATE TABLE IF NOT EXISTS kb_mr_event (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID NOT NULL,
    merge_request_id UUID NOT NULL,
    actor_type       TEXT NOT NULL CHECK (actor_type IN ('member', 'agent')),
    actor_id         UUID NOT NULL,
    kind             TEXT NOT NULL,
    payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
