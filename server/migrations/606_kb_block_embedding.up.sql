-- One embedding per mainline block for hybrid search. Created only where the
-- vector extension is installed (see 605); code that reads it must check that
-- the table exists.
CREATE TABLE IF NOT EXISTS kb_block_embedding (
    page_id           UUID NOT NULL,
    block_id          TEXT NOT NULL,
    knowledge_base_id UUID NOT NULL,
    workspace_id      UUID NOT NULL,
    -- sha256 of the block plain text; unchanged blocks are not re-embedded.
    content_hash      TEXT NOT NULL,
    -- Model that produced the vector; a model change re-embeds everything.
    model             TEXT NOT NULL,
    embedding         vector(1024) NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (page_id, block_id)
);
