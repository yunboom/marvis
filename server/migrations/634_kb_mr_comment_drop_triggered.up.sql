-- Review comments no longer start agents (decision 107): drop the record of
-- the agents a comment started.
ALTER TABLE kb_mr_comment DROP COLUMN IF EXISTS triggered;
