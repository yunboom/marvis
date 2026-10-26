# 5 数据模型

全部是知识库自己的表（前缀 `kb_`），只引用通用系统的 id（智能体、聊天会话、任务），不改通用系统的表（决策 36）。作业状态不落库，取对话最近一次智能体执行的状态。

   kb_workspace 工作区级计数 uuid workspace_id PK · 工作区 int next_mr_number 下一个变更请求编号 ts updated_at     kb_base 知识库；PURPOSE / SCHEMA 直接存列 uuid id PK uuid workspace_id FK → kb_workspace text name 名称 text slug 工作区内唯一 text description 简介 text schema_mode default / custom text purpose 目标（Markdown） text schema Schema（Markdown） bigint content_version 每次合并 +1 uuid created_by  ts created_at  ts updated_at     kb_config_revision 配置每次保存一行 uuid id PK uuid knowledge_base_id FK → kb_base text name  text description  text schema_mode  text purpose  text schema  uuid saved_by 保存人 ts created_at     kb_builder_session 构建器对话的右侧配置（照 agent_builder_draft） uuid chat_session_id PK · 现有聊天会话 uuid workspace_id  text mode create / config uuid? knowledge_base_id FK → kb_base，创建为 NULL jsonb draft 右侧配置，服务端不解析 ts updated_at     kb_raw 原始资料（文件在对象存储） uuid id PK uuid knowledge_base_id FK → kb_base text kind source / asset text name 文件名，库内唯一 text storage_key 对象存储键 bigint size  text content_type  uuid uploaded_by  ts created_at     kb_page 主线上的页面（当前状态） uuid id PK · 稳定页面 id uuid knowledge_base_id FK → kb_base uuid? parent_id 父页面，NULL = 顶层 text position 同级排序键 text slug 路径段，同级唯一 text type OKF type text title  text description  jsonb frontmatter 完整页头，含未知键 jsonb blocks [{id, kind, content}]，kind 目前只有 text uuid head_revision_id FK → kb_page_revision ts? stale_after 复核期 ts? deleted_at 删除后保留，链接显示「已删除」 ts updated_at     kb_block_embedding 块向量，混合检索用 uuid page_id PK · FK → kb_page text block_id PK uuid knowledge_base_id  text content_hash 没变不重算 text model  vector embedding 1024 维 ts updated_at     kb_page_revision 页面修订，只追加 uuid id PK uuid page_id FK → kb_page uuid? prev_revision_id 上一修订 uuid? merge_request_id FK → 合并它的变更请求 uuid? parent_id  text position  text slug  jsonb frontmatter  jsonb blocks  jsonb claims 论断快照 bool deleted  ts created_at     kb_claim 论断（主线当前状态） uuid id PK uuid knowledge_base_id  uuid page_id FK → kb_page text block_id 所在块 text key 页内编号 c1… text text 陈述 jsonb evidence [{source, uri, title, version}] ts checked_at 核实时间 ts updated_at     kb_link 页面间链接（主线） uuid from_page_id FK → kb_page text from_block_id  uuid? to_page_id NULL = 还没写的页面 text to_block_id  text to_path 写入时的路径 uuid knowledge_base_id     kb_draft 草稿：一组未合并的页面改动 uuid id PK uuid workspace_id  uuid knowledge_base_id FK → kb_base text title 草稿标题，可为空 bigint version 每次写入 +1 text status open / submitted / merged / discarded uuid created_by 发起人 uuid? task_id 创建它的任务，追溯用 ts created_at  ts updated_at     kb_draft_page 草稿里改动的页面 uuid draft_id PK · FK → kb_draft uuid page_id PK · 新建页面也先分配 id text op create / update / move / delete uuid? base_revision_id 改动基于的修订 uuid? parent_id  text position  text slug  jsonb frontmatter  jsonb blocks  jsonb claims  jsonb conflicts 同步主线后没解决的冲突 ts updated_at     kb_job 知识库作业 = 对话 + 草稿 uuid id PK uuid knowledge_base_id FK → kb_base text name  text starter 开场白类型 uuid agent_id 执行智能体 uuid chat_session_id 现有聊天会话 uuid draft_id FK → kb_draft uuid[] annotation_ids 带入的批注 uuid? page_id 发起时所在页面 uuid created_by  ts created_at  ts updated_at     kb_annotation 批注：一句 / 本页 / 整个知识库 uuid id PK uuid knowledge_base_id  uuid? page_id FK → kb_page，NULL = 整库 text block_id  text quote 原句 text prefix  text suffix  text body  text author_type member / agent uuid author_id  text status pending…dismissed uuid? merge_request_id FK → 变更请求 ts created_at     kb_merge_request 变更请求 uuid id PK uuid workspace_id  int number 工作区内唯一 uuid knowledge_base_id  text title  text summary  text source ingest…custom text risk low…high text author_type  uuid author_id  uuid draft_id FK → kb_draft uuid? job_id FK → kb_job uuid? task_id 追溯来源 uuid[] annotation_ids  uuid? reverts_id 回滚的变更请求 text status open / merged / closed uuid? merged_by  ts? merged_at  uuid? closed_by  ts? closed_at  text close_reason  ts created_at     kb_mr_comment 审核评论 uuid id PK uuid merge_request_id FK → kb_merge_request uuid? parent_id 回复的评论 uuid? quote_page_id 引用的页面 text quote_block_id 引用的块 text quote_text 引用的行 text body Markdown，含 @提及 text author_type  uuid author_id  ts created_at    1:N  1:N  1:N  1:0..N  1:N  1:N  1:N  1:N  1:N  1:0..N  1:N  1:N  1:0..1  1:0..N  N:0..1  1:N 
图 2 · ER 图（点开放大）。连线是应用层关联，不建外键。
DDL

```
-- 应用层维护关联，不建外键（AGENTS.md「Database and Migration Rules」）
CREATE TABLE kb_workspace (
    workspace_id       UUID PRIMARY KEY,
    next_mr_number INTEGER NOT NULL DEFAULT 1,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE kb_base (
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

CREATE TABLE kb_config_revision (
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

-- 照 agent_builder_draft（迁移 252）：聊天会话就是构建器会话，这里只存右侧配置；
-- 主键用聊天会话 id，写入是 upsert，也省掉单独的索引
CREATE TABLE kb_builder_session (
    chat_session_id   UUID PRIMARY KEY,
    workspace_id      UUID NOT NULL,
    mode              TEXT NOT NULL CHECK (mode IN ('create', 'config')),
    knowledge_base_id UUID,                      -- 配置时有值，创建为 NULL
    draft             JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE kb_raw (
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

CREATE TABLE kb_page (
    id                UUID PRIMARY KEY,
    workspace_id      UUID NOT NULL,
    knowledge_base_id UUID NOT NULL,
    parent_id         UUID,
    position          TEXT NOT NULL,             -- 分数排序键，插入不重排兄弟
    slug              TEXT NOT NULL,
    type              TEXT NOT NULL,
    title             TEXT NOT NULL,
    description       TEXT NOT NULL,
    frontmatter       JSONB NOT NULL,            -- 完整页头，含未知键
    blocks            JSONB NOT NULL,            -- [{id, kind, content}]，kind 目前只有 text，content 是一段 Markdown
    search_text       TEXT NOT NULL DEFAULT '',  -- 标题 + 块纯文本，检索用
    head_revision_id  UUID NOT NULL,
    stale_after       TIMESTAMPTZ,
    deleted_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE EXTENSION IF NOT EXISTS vector;          -- 镜像 pgvector/pgvector:pg17 自带

CREATE TABLE kb_block_embedding (                -- 混合检索的向量一路，每块一条，只存主线
    page_id           UUID NOT NULL,
    block_id          TEXT NOT NULL,
    knowledge_base_id UUID NOT NULL,
    workspace_id      UUID NOT NULL,
    content_hash      TEXT NOT NULL,             -- 块纯文本的 sha256，没变就不重算
    model             TEXT NOT NULL,             -- 生成向量的模型；换模型时据此全量重算
    embedding         vector(1024) NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (page_id, block_id)
);

CREATE TABLE kb_page_revision (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL,
    knowledge_base_id UUID NOT NULL,
    page_id           UUID NOT NULL,
    prev_revision_id  UUID,
    merge_request_id UUID,                      -- NULL = 建库时的初始修订
    parent_id         UUID,
    position          TEXT NOT NULL,
    slug              TEXT NOT NULL,
    frontmatter       JSONB NOT NULL,
    blocks            JSONB NOT NULL,
    claims            JSONB NOT NULL,
    deleted           BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE kb_claim (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL,
    knowledge_base_id UUID NOT NULL,
    page_id           UUID NOT NULL,
    block_id          TEXT NOT NULL,
    key               TEXT NOT NULL,
    text              TEXT NOT NULL,
    evidence          JSONB NOT NULL,            -- [{source, uri, title, version}]
    checked_at        TIMESTAMPTZ NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE kb_link (
    workspace_id      UUID NOT NULL,
    knowledge_base_id UUID NOT NULL,
    from_page_id      UUID NOT NULL,
    from_block_id     TEXT NOT NULL,
    to_page_id        UUID,                      -- NULL = 还没写的页面
    to_block_id       TEXT NOT NULL DEFAULT '',
    to_path           TEXT NOT NULL
);

CREATE TABLE kb_draft (
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

CREATE TABLE kb_draft_page (
    draft_id          UUID NOT NULL,
    page_id           UUID NOT NULL,
    op                TEXT NOT NULL CHECK (op IN ('create', 'update', 'move', 'delete')),
    base_revision_id  UUID,                      -- create 为 NULL
    parent_id         UUID,
    position          TEXT NOT NULL,
    slug              TEXT NOT NULL,
    frontmatter       JSONB NOT NULL,
    blocks            JSONB NOT NULL,
    claims            JSONB NOT NULL,
    conflicts         JSONB NOT NULL DEFAULT '[]',  -- kb draft sync 后没解决的冲突
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (draft_id, page_id)
);

CREATE TABLE kb_job (
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

CREATE TABLE kb_annotation (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL,
    knowledge_base_id UUID NOT NULL,
    page_id           UUID,                      -- NULL = 整个知识库
    block_id          TEXT NOT NULL DEFAULT '',
    quote             TEXT NOT NULL DEFAULT '',
    prefix            TEXT NOT NULL DEFAULT '',
    suffix            TEXT NOT NULL DEFAULT '',
    body              TEXT NOT NULL,
    author_type       TEXT NOT NULL CHECK (author_type IN ('member', 'agent')),
    author_id         UUID NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'resolved', 'dismissed')),
    merge_request_id UUID,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (page_id IS NOT NULL OR quote = '')
);

CREATE TABLE kb_merge_request (
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

CREATE TABLE kb_mr_comment (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merge_request_id UUID NOT NULL,
    parent_id         UUID,
    quote_page_id     UUID,
    quote_block_id    TEXT NOT NULL DEFAULT '',
    quote_text        TEXT NOT NULL DEFAULT '',
    body              TEXT NOT NULL,
    author_type       TEXT NOT NULL CHECK (author_type IN ('member', 'agent')),
    author_id         UUID NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```
-- 每个索引单独一个迁移文件，CONCURRENTLY（AGENTS.md 约定）
CREATE UNIQUE INDEX CONCURRENTLY kb_base_ws_slug_uidx ON kb_base (workspace_id, slug);
CREATE UNIQUE INDEX CONCURRENTLY kb_page_sibling_slug_uidx ON kb_page
    (knowledge_base_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'), slug)
    WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX CONCURRENTLY kb_raw_base_name_uidx ON kb_raw (knowledge_base_id, kind, name);
CREATE INDEX CONCURRENTLY kb_page_parent_idx ON kb_page (knowledge_base_id, parent_id, position);
CREATE INDEX CONCURRENTLY kb_page_stale_idx ON kb_page (knowledge_base_id, stale_after) WHERE deleted_at IS NULL;
CREATE INDEX CONCURRENTLY kb_revision_page_idx ON kb_page_revision (page_id, created_at DESC);
CREATE INDEX CONCURRENTLY kb_claim_page_idx ON kb_claim (page_id);
CREATE INDEX CONCURRENTLY kb_claim_evidence_gin ON kb_claim USING GIN (evidence jsonb_path_ops);
CREATE INDEX CONCURRENTLY kb_link_to_idx ON kb_link (to_page_id);
CREATE INDEX CONCURRENTLY kb_link_from_idx ON kb_link (from_page_id);
CREATE INDEX CONCURRENTLY kb_draft_page_page_idx ON kb_draft_page (page_id);
CREATE UNIQUE INDEX CONCURRENTLY kb_job_chat_session_uidx ON kb_job (chat_session_id);
CREATE INDEX CONCURRENTLY kb_job_base_created_idx ON kb_job (knowledge_base_id, created_at DESC);
CREATE INDEX CONCURRENTLY kb_annotation_base_status_idx ON kb_annotation (knowledge_base_id, status);
CREATE UNIQUE INDEX CONCURRENTLY kb_mr_ws_number_uidx ON kb_merge_request (workspace_id, number);
CREATE UNIQUE INDEX CONCURRENTLY kb_mr_open_draft_uidx ON kb_merge_request (draft_id) WHERE status = 'open';
CREATE INDEX CONCURRENTLY kb_mr_ws_status_idx ON kb_merge_request (workspace_id, status, updated_at DESC);
CREATE INDEX CONCURRENTLY kb_mr_comment_idx ON kb_mr_comment (merge_request_id, created_at);
-- 检索：照迁移 032 / 137，pg_bigm 可用时建 bigm 索引，否则 pg_trgm
CREATE INDEX CONCURRENTLY kb_page_search_bigm ON kb_page USING gin (LOWER(search_text) gin_bigm_ops);
-- 向量一路：HNSW 余弦距离（pgvector README「HNSW」）
CREATE INDEX CONCURRENTLY kb_block_embedding_hnsw ON kb_block_embedding USING hnsw (embedding vector_cosine_ops);
CREATE INDEX CONCURRENTLY kb_block_embedding_base_idx ON kb_block_embedding (knowledge_base_id);
```

落库形态（与下文接口示例同一个页面、同一份草稿）

```
{
  "kb_page": {                                                // kb_page 一行（节选）
    "id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",             // 稳定页面 id
    "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 知识库
    "parent_id": "11223344-5566-4778-8899-aabbccddeeff",      // 父页面「支付」
    "position": "a1",                                         // 同级排序键
    "slug": "callback",                                       // 路径段 → /payment/callback
    "type": "Workflow",                                       // 冗余一份，便于过滤
    "title": "支付回调",                                          // 标题
    "description": "渠道异步回调的接收、去重与失败处理",                       // 一句话说明
    "frontmatter": {                                          // 完整页头（JSON 存储，导出时转 YAML）
      "type": "Workflow",                                     // 冗余一份，便于过滤
      "title": "支付回调",                                        // 标题
      "tags": [                                               // 标签
        "dev",
        "qa"
      ],
      "status": "stable"                                      // 生命周期
    },
    "blocks": [                                               // 正文块
      {
        "id": "b7Kq",                                         // 稳定页面 id
        "kind": "text",                                       // 块类型，目前只有 text（内容是一段 Markdown）
        "content": "## 去重"                                    // 块内容：一段 Markdown；链接存 kb://页面id#块id（示例截短）
      },
      {
        "id": "b8Xz",                                         // 稳定页面 id
        "kind": "text",                                       // 块类型，目前只有 text（内容是一段 Markdown）
        "content": "按渠道交易号去重。[^mar-142]"                      // 块内容：一段 Markdown；链接存 kb://页面id#块id（示例截短）
      },
      {
        "id": "b9Ln",                                         // 稳定页面 id
        "kind": "text",                                       // 块类型，目前只有 text（内容是一段 Markdown）
        "content": "见[幂等键](kb://22334455#b9Lm)。"              // 块内容：一段 Markdown；链接存 kb://页面id#块id（示例截短）
      }
    ],
    "head_revision_id": "44556677-8899-4aab-9ccd-deeff0011223",  // 当前修订
    "stale_after": "2027-01-20T00:00:00Z",                    // 复核期
    "deleted_at": null                                        // 未删除为 null
  },
  "kb_draft_page": {                                          // kb_draft_page 一行（节选，同一页的草稿）
    "draft_id": "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",       // 草稿
    "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",        // 页面
    "op": "update",                                           // update
    "base_revision_id": "44556677-8899-4aab-9ccd-deeff0011223",  // 改动基于的修订；合并时与 head_revision_id 比较；kb draft sync 后推进到主线当前修订
    "blocks": [                                               // 正文块
      {
        "id": "b8Xz",                                         // 稳定页面 id
        "kind": "text",                                       // 块类型，目前只有 text（内容是一段 Markdown）
        "content": "按渠道交易号去重……"                               // 块内容：一段 Markdown；链接存 kb://页面id#块id（示例截短）
      }
    ]
  }
}
```

| 不建表的东西 | 放在哪 | 
| 原始资料文件 | 对象存储；`kb_raw` 只存元数据 | 
| index | 不存在；导出时按页面树生成 index.md | 
| 作业状态（运行中 / 失败 / 已停止） | 对话最近一次任务的状态（现有聊天） | 
| 定时收录 / 健康检查 | 用户自建的普通自动化 | 
| 缺口 | 知识库级批注（`page_id = NULL`，决策 15） | 
| 草稿里的链接、反向链接 | 读草稿时现算；`kb_link` 只存主线 |
