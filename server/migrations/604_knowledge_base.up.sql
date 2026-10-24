-- Knowledge base (docs/adr/0002-knowledge-base.md). All knowledge bases of a
-- workspace live as directories of one git repository; these tables hold the
-- review and annotation state around it. No foreign keys: dependents are
-- swept in application code (knowledge base delete, workspace delete).

-- One row per workspace once its repository exists. next_change_number hands
-- out the per-workspace #N of change requests.
CREATE TABLE IF NOT EXISTS knowledge_repo (
    workspace_id       UUID PRIMARY KEY,
    next_change_number INTEGER NOT NULL DEFAULT 1,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_base (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        UUID NOT NULL,
    name                TEXT NOT NULL,
    slug                TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    maintainer_agent_id UUID,
    created_by          UUID NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, slug)
);

CREATE TABLE IF NOT EXISTS knowledge_change_request (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID NOT NULL,
    number           INTEGER NOT NULL,
    title            TEXT NOT NULL,
    source           TEXT NOT NULL
        CHECK (source IN ('fix', 'ingest', 'fresh', 'merge', 'gap', 'digest', 'edit', 'revert', 'agent')),
    author_type      TEXT NOT NULL CHECK (author_type IN ('member', 'agent')),
    author_id        UUID NOT NULL,
    branch           TEXT NOT NULL,
    base_commit      TEXT NOT NULL,
    head_commit      TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'closed')),
    conflict         BOOLEAN NOT NULL DEFAULT FALSE,
    conflict_files   TEXT[] NOT NULL DEFAULT '{}',
    summary          TEXT NOT NULL DEFAULT '',
    risk             TEXT NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'medium', 'high')),
    merge_commit     TEXT,
    chat_session_id  UUID,
    annotation_ids   UUID[] NOT NULL DEFAULT '{}',
    -- Knowledge base directories the diff touches, refreshed on every update.
    kb_slugs         TEXT[] NOT NULL DEFAULT '{}',
    merged_by        UUID,
    merged_at        TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, number),
    UNIQUE (workspace_id, branch)
);

CREATE TABLE IF NOT EXISTS knowledge_change_comment (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_request_id UUID NOT NULL,
    path              TEXT NOT NULL,
    line              INTEGER NOT NULL,
    author_type       TEXT NOT NULL CHECK (author_type IN ('member', 'agent')),
    author_id         UUID NOT NULL,
    body              TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_annotation (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL,
    knowledge_base_id UUID NOT NULL,
    page_path         TEXT NOT NULL,
    -- quote empty = a page-level annotation; prefix/suffix re-anchor the quote
    -- after the page is rewritten.
    quote             TEXT NOT NULL DEFAULT '',
    prefix            TEXT NOT NULL DEFAULT '',
    suffix            TEXT NOT NULL DEFAULT '',
    body              TEXT NOT NULL,
    author_type       TEXT NOT NULL CHECK (author_type IN ('member', 'agent')),
    author_id         UUID NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'resolved', 'dismissed')),
    change_request_id UUID,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_gap (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    question     TEXT NOT NULL,
    source       TEXT NOT NULL CHECK (source IN ('search_miss', 'agent')),
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'filled')),
    created_by_type TEXT NOT NULL CHECK (created_by_type IN ('member', 'agent')),
    created_by_id   UUID NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A knowledge session: the hidden carrier agent and chat session that run one
-- knowledge operation (fix / ingest / fresh / merge / gap / create / rebase).
CREATE TABLE IF NOT EXISTS knowledge_session (
    chat_session_id   UUID PRIMARY KEY,
    workspace_id      UUID NOT NULL,
    carrier_agent_id  UUID NOT NULL,
    knowledge_base_id UUID,
    kind              TEXT NOT NULL
        CHECK (kind IN ('fix', 'ingest', 'fresh', 'merge', 'gap', 'create', 'rebase')),
    created_by        UUID NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- system_key marks a platform-owned autopilot (the daily knowledge digest):
-- it cannot be deleted and cannot be enabled without a knowledge base.
ALTER TABLE autopilot ADD COLUMN IF NOT EXISTS system_key TEXT;
