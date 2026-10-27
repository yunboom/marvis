-- The sentence an annotation was written on. Merges rewrite pages and the
-- annotation follows its sentence: quote is the sentence as it reads now,
-- original_quote keeps the wording at annotation time once the two differ
-- (empty while they are the same).
ALTER TABLE kb_annotation ADD COLUMN IF NOT EXISTS original_quote TEXT NOT NULL DEFAULT '';
