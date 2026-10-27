-- The agents a review comment started (spec 7.9 "triggered"), with the task
-- and chat each one runs in, so the review page can show who is working on
-- the comment and link to the run.
ALTER TABLE kb_mr_comment ADD COLUMN IF NOT EXISTS triggered JSONB NOT NULL DEFAULT '[]'::jsonb;
