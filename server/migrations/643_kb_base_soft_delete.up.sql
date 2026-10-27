-- Deleting a knowledge base is a soft delete: the row and everything in it
-- stay, and every read path leaves out rows with deleted_at set.
-- deleted_by records the member who deleted it, for audit.
ALTER TABLE kb_base
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by UUID;
