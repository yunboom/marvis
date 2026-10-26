-- Knowledge base v2: pages and revisions live in Postgres, edits go through
-- drafts and merge requests. Relationships are maintained by application code;
-- no foreign keys (AGENTS.md "Database and Migration Rules"). Indexes are built
-- concurrently by the following single-statement migrations. The block
-- embedding table is created separately because pgvector is optional.

-- Workspace-level counters.
CREATE TABLE IF NOT EXISTS kb_workspace (
    workspace_id   UUID PRIMARY KEY,
    next_mr_number INTEGER NOT NULL DEFAULT 1,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A knowledge base; PURPOSE and SCHEMA are stored inline.
CREATE TABLE IF NOT EXISTS kb_base (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL,
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    schema_mode     TEXT NOT NULL CHECK (schema_mode IN ('default', 'custom')),
    purpose         TEXT NOT NULL DEFAULT '',
    schema          TEXT NOT NULL,
    content_version BIGINT NOT NULL DEFAULT 0,
    created_by      UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per saved configuration.
CREATE TABLE IF NOT EXISTS kb_config_revision (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    knowledge_base_id UUID NOT NULL,
    name              TEXT NOT NULL,
    description       TEXT NOT NULL,
    schema_mode       TEXT NOT NULL,
    purpose           TEXT NOT NULL,
    schema            TEXT NOT NULL,
    saved_by          UUID NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Right-hand configuration of a builder conversation (mirrors
-- agent_builder_draft, migration 252). The chat session is the builder
-- session, so its id is the primary key and writes are upserts.
CREATE TABLE IF NOT EXISTS kb_builder_session (
    chat_session_id   UUID PRIMARY KEY,
    workspace_id      UUID NOT NULL,
    mode              TEXT NOT NULL CHECK (mode IN ('create', 'config')),
    knowledge_base_id UUID,
    draft             JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw source files; the bytes live in object storage.
CREATE TABLE IF NOT EXISTS kb_raw (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL,
    knowledge_base_id UUID NOT NULL,
    kind              TEXT NOT NULL CHECK (kind IN ('source', 'asset')),
    name              TEXT NOT NULL,
    storage_key       TEXT NOT NULL,
    size              BIGINT NOT NULL,
    content_type      TEXT NOT NULL,
    uploaded_by       UUID NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Current mainline state of a page. blocks is [{id, kind, content}] where
-- content is one Markdown fragment; position is a fractional sort key so an
-- insert never renumbers siblings.
CREATE TABLE IF NOT EXISTS kb_page (
    id                UUID PRIMARY KEY,
    workspace_id      UUID NOT NULL,
    knowledge_base_id UUID NOT NULL,
    parent_id         UUID,
    position          TEXT NOT NULL,
    slug              TEXT NOT NULL,
    reserved          TEXT NOT NULL DEFAULT '' CHECK (reserved IN ('', 'quickstart')),
    type              TEXT NOT NULL,
    title             TEXT NOT NULL,
    description       TEXT NOT NULL,
    frontmatter       JSONB NOT NULL,
    blocks            JSONB NOT NULL,
    search_text       TEXT NOT NULL DEFAULT '',
    head_revision_id  UUID NOT NULL,
    stale_after       TIMESTAMPTZ,
    deleted_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only page history. merge_request_id is NULL for the initial
-- revision written when the knowledge base is created.
CREATE TABLE IF NOT EXISTS kb_page_revision (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL,
    knowledge_base_id UUID NOT NULL,
    page_id           UUID NOT NULL,
    prev_revision_id  UUID,
    merge_request_id  UUID,
    parent_id         UUID,
    position          TEXT NOT NULL,
    slug              TEXT NOT NULL,
    frontmatter       JSONB NOT NULL,
    blocks            JSONB NOT NULL,
    claims            JSONB NOT NULL,
    deleted           BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Claims on the mainline.
CREATE TABLE IF NOT EXISTS kb_claim (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL,
    knowledge_base_id UUID NOT NULL,
    page_id           UUID NOT NULL,
    block_id          TEXT NOT NULL,
    key               TEXT NOT NULL,
    text              TEXT NOT NULL,
    evidence          JSONB NOT NULL,
    checked_at        TIMESTAMPTZ NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Links between mainline pages. to_page_id is NULL for a page not yet written.
CREATE TABLE IF NOT EXISTS kb_link (
    workspace_id      UUID NOT NULL,
    knowledge_base_id UUID NOT NULL,
    from_page_id      UUID NOT NULL,
    from_block_id     TEXT NOT NULL,
    to_page_id        UUID,
    to_block_id       TEXT NOT NULL DEFAULT '',
    to_path           TEXT NOT NULL
);

-- A draft: a set of unmerged page changes.
CREATE TABLE IF NOT EXISTS kb_draft (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL,
    knowledge_base_id UUID NOT NULL,
    title             TEXT NOT NULL DEFAULT '',
    version           BIGINT NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'submitted', 'merged', 'discarded')),
    created_by        UUID NOT NULL,
    task_id           UUID,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A page changed inside a draft. base_revision_id is NULL for created pages.
CREATE TABLE IF NOT EXISTS kb_draft_page (
    draft_id         UUID NOT NULL,
    page_id          UUID NOT NULL,
    op               TEXT NOT NULL CHECK (op IN ('create', 'update', 'move', 'delete')),
    base_revision_id UUID,
    parent_id        UUID,
    position         TEXT NOT NULL,
    slug             TEXT NOT NULL,
    frontmatter      JSONB NOT NULL,
    blocks           JSONB NOT NULL,
    claims           JSONB NOT NULL,
    conflicts        JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (draft_id, page_id)
);

-- A knowledge base job: one chat conversation plus one draft.
CREATE TABLE IF NOT EXISTS kb_job (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL,
    knowledge_base_id UUID NOT NULL,
    name              TEXT NOT NULL,
    starter           TEXT NOT NULL CHECK (starter IN
        ('ingest', 'health', 'merge', 'annotations', 'new_page', 'schedule', 'custom')),
    agent_id          UUID NOT NULL,
    chat_session_id   UUID NOT NULL,
    draft_id          UUID NOT NULL,
    annotation_ids    UUID[] NOT NULL DEFAULT '{}',
    page_id           UUID,
    created_by        UUID NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Annotations on a sentence, a page, or the whole knowledge base (page_id NULL).
CREATE TABLE IF NOT EXISTS kb_annotation (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL,
    knowledge_base_id UUID NOT NULL,
    page_id           UUID,
    block_id          TEXT NOT NULL DEFAULT '',
    quote             TEXT NOT NULL DEFAULT '',
    prefix            TEXT NOT NULL DEFAULT '',
    suffix            TEXT NOT NULL DEFAULT '',
    body              TEXT NOT NULL,
    author_type       TEXT NOT NULL CHECK (author_type IN ('member', 'agent')),
    author_id         UUID NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'resolved', 'dismissed')),
    merge_request_id  UUID,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (page_id IS NOT NULL OR quote = '')
);

-- Merge requests; number is unique within the workspace.
CREATE TABLE IF NOT EXISTS kb_merge_request (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL,
    number            INTEGER NOT NULL,
    knowledge_base_id UUID NOT NULL,
    title             TEXT NOT NULL,
    summary           TEXT NOT NULL DEFAULT '',
    source            TEXT NOT NULL CHECK (source IN ('ingest', 'health', 'merge',
        'annotations', 'new_page', 'revert', 'custom')),
    risk              TEXT NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'medium', 'high')),
    author_type       TEXT NOT NULL CHECK (author_type IN ('member', 'agent')),
    author_id         UUID NOT NULL,
    draft_id          UUID NOT NULL,
    job_id            UUID,
    task_id           UUID,
    annotation_ids    UUID[] NOT NULL DEFAULT '{}',
    reverts_id        UUID,
    status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'closed')),
    merged_by         UUID,
    merged_at         TIMESTAMPTZ,
    closed_by         UUID,
    closed_at         TIMESTAMPTZ,
    close_reason      TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Review comments on a merge request.
CREATE TABLE IF NOT EXISTS kb_mr_comment (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merge_request_id UUID NOT NULL,
    parent_id        UUID,
    quote_page_id    UUID,
    quote_block_id   TEXT NOT NULL DEFAULT '',
    quote_text       TEXT NOT NULL DEFAULT '',
    body             TEXT NOT NULL,
    author_type      TEXT NOT NULL CHECK (author_type IN ('member', 'agent')),
    author_id        UUID NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
