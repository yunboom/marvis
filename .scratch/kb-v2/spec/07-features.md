# 7 功能实现（对照设计稿）

#### 7.1 知识库列表与创建

设计稿 · 1.1 列表 · 1.2–1.3 对话创建 · 1.4 空状态 · 1.5–1.6 默认 / 自定义 Schema

- 列表：读 `kb_base`，页面数按知识库 `count(*)`（不含已删除）。
- 创建只有对话一种方式（决策 7）：前端复用创建智能体的 `BuilderSetup` / `BuilderConversation`（`packages/views/agents/create/builder-conversation.tsx:37`、`:136`），没有运行时的选择卡片和「连接运行时」也一起复用（决策 28）。
- 照创建智能体做（决策 69，`9a7f600b6` `server/internal/handler/agent_builder.go:57-162`、`server/cmd/server/router.go:2398-2407`）：每开一次对话新建一个隐藏构建器智能体（`kind = system`，`system_key = kb-builder:<流程 id>`，指令是 8.3 的构建器提示词）和一个聊天会话。聊天列表只列 `kind = user` 的智能体，所以构建器对话不出现在聊天页面，只能从知识库的创建 / 配置入口回到它，且只有发起人可见。
- 构建器回复末尾带一行 `<kb_draft>{…}</kb_draft>`，前端解析后填右侧；用户在右侧手改的内容通过「保存右侧配置」存到 `kb_builder_session.draft`，刷新、切页不丢（同 `agent_builder_draft`，迁移 252）。
- 复用组件自带的三样，界面保持一致：「您有 N 条未完成的创建」横幅（1 条直接进入，多条弹窗选，`packages/views/agents/create/unfinished-drafts.tsx`）；「放弃创建」及确认弹窗（「对话和右侧配置都会被永久删除」）；运行时旁的「更换」。配置模式同样适用，横幅文案为「未完成的配置」。
- Schema「默认 / 自定义」（决策 49）：默认时右侧只读，创建时服务端写入当时的内置模板（4.5），平台升级模板不覆盖已有知识库；Schema 模式是用户的输入：用户在右侧选「默认 / 自定义」，决定构建器要不要起草 Schema；构建器的输出不带模式。建会话时带初始模式，用户中途切换后，下一条消息的 JSON 信封里带上当前模式（创建智能体的构建器本来就把用户消息包成 JSON 信封），右侧配置保存时也存它。创建 / 更新时 `default` 不传 `schema`，`custom` 才传（决策 70）。
- 创建在一个事务里：写 `kb_base`、`kb_config_revision`；不建页面（决策 103）。
- 创建成功后前端跳到新知识库的「知识库作业」并打开一个新对话（`/kb/{slug}/jobs/new?welcome=1`，设计稿 1.10）：顶部提示已创建，开场白上方是四步上手引导（收录资料、审核后生效、阅读和批注、定时维护），「收录资料」标「建议先做」。引导是前端文案，不调接口、不启动智能体；用户选开场白或直接输入后，才按 7.10 新建作业（决策 71）。

GET`/api/kb/bases`
 
列出工作区的知识库。

 
权限 工作区成员

 
响应 200

```
[
  {
    "id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",             // 知识库 id（UUID）
    "workspace_id": "ws_8f2a1c",                              // 工作区 id
    "name": "团队知识库",                                          // 名称
    "slug": "team",                                           // 工作区内唯一，小写字母 / 数字 / 连字符；页面引用写 slug:/路径
    "description": "订单、支付、发布与测试流程，团队共用的业务和系统知识。",             // 简介；智能体据此判断要不要用这个知识库
    "schema_mode": "default",                                 // default 内置模板（只读）/ custom 自定义
    "created_by": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",     // 创建人
    "page_count": 42,                                         // 页面数
    "content_version": 87,                                    // 内容版本，每次合并 +1；ETag 和检索索引以它为准
    "created_at": "2026-10-08T09:12:03Z",                     // RFC3339
    "updated_at": "2026-10-25T14:20:11Z"                      // RFC3339
  }
]
```

 
GET`/api/kb/bases/{kb}`
 
知识库详情（含目标、Schema 全文）；`{kb}` 是 id 或 slug。`kb get`、知识库卡片悬停都用它。

 
权限 工作区成员

 
响应 200

```
{
  "id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",               // 知识库 id（UUID）
  "workspace_id": "ws_8f2a1c",                                // 工作区 id
  "name": "团队知识库",                                            // 名称
  "slug": "team",                                             // 工作区内唯一，小写字母 / 数字 / 连字符；页面引用写 slug:/路径
  "description": "订单、支付、发布与测试流程，团队共用的业务和系统知识。",               // 简介；智能体据此判断要不要用这个知识库
  "schema_mode": "default",                                   // default 内置模板（只读）/ custom 自定义
  "created_by": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",       // 创建人
  "page_count": 42,                                           // 页面数
  "content_version": 87,                                      // 内容版本，每次合并 +1；ETag 和检索索引以它为准
  "created_at": "2026-10-08T09:12:03Z",                       // RFC3339
  "updated_at": "2026-10-25T14:20:11Z",                       // RFC3339
  "purpose": "# 目标\n\n## 读者\n研发和测试……\n",                      // 目标全文（Markdown，只有详情返回）
  "schema": "# Schema\n\nThis file tells agents……\n"          // Schema 全文（Markdown，只有详情返回；默认模式为创建时写入的内置模板）
}
```

 
GET`/api/kb/builder/sessions`
 
发起人自己未完成的构建器对话（「未完成的创建 / 配置」横幅用）。

 
权限 工作区成员；只返回自己发起的

 
| 参数 | 位置 | 类型 | 必填 | 说明 / 示例 | 
| `mode` | query | string | 否 | `create` / `config` | 
| `kb` | query | string | 否 | 配置模式下只看某个知识库的 | 

 
响应 200

```
[
  {
    "session_id": "d1e2f3a4-5b6c-4d7e-8f9a-0b1c2d3e4f5a",     // 聊天会话 id（就是构建器会话 id）
    "mode": "create",                                         // 新建 / 配置
    "knowledge_base_id": null,                                // 配置时的知识库
    "title": "新建知识库",                                         // 对话标题
    "runtime_id": "rt_6c1d",                                  // 构建器所在运行时
    "last_message_content": "<kb_draft>{…}</kb_draft>",       // 最后一条消息原文，客户端解析
    "last_message_role": "assistant",                         // user / assistant
    "last_message_at": "2026-10-25T09:16:00Z",                // 最后一条消息时间
    "draft": {                                                // 保存过的右侧配置，服务端不解析；没保存过为 null，客户端取最后一个 
      "name": "支付排障手册",                                       // 名称
      "schema_mode": "default"                                // Schema 模式
    },
    "updated_at": "2026-10-25T09:16:00Z"                      // RFC3339
  }
]
```

 
POST`/api/kb/builder/sessions`
 
开启构建器对话：建隐藏构建器智能体，建聊天会话（一个事务）。之后的消息走现有聊天接口 `POST /api/chat/sessions/{id}/messages`。

 
权限 工作区成员；配置模式要求知识库创建者或 owner / admin

 
请求体

```
{
  "mode": "create",                                           // create 新建 / config 配置
  "knowledge_base_id": null,                                  // 配置时必填，新建为 null
  "schema_mode": "default",                                   // 初始 Schema 模式：新建默认 default；配置时取知识库当前值。之后切换随消息信封传给构建器
  "runtime_id": "rt_6c1d",                                    // 构建器运行在哪个运行时
  "model": "claude-sonnet-5-5"                                // 模型，取该运行时可用的模型
}
```

 
响应 201

```
{
  "session_id": "d1e2f3a4-5b6c-4d7e-8f9a-0b1c2d3e4f5a",       // 聊天会话 id，前端用它收发消息
  "builder_agent_id": "a0b1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",  // 隐藏构建器智能体
  "runtime_id": "rt_6c1d"                                     // 同请求
}
```

 
PATCH`/api/kb/builder/sessions/{id}/runtime`
 
更换运行时（照 `SwitchAgentBuilderRuntime`）。

 
权限 发起人

 
请求体

```
{
  "runtime_id": "rt_9a2e"                                     // 新的运行时
}
```

 
响应 200

```
{
  "session_id": "d1e2f3a4-5b6c-4d7e-8f9a-0b1c2d3e4f5a",       // 会话
  "runtime_id": "rt_9a2e"                                     // 生效的运行时
}
```

 
| 状态码 | 情况 | 
| 400 | 运行时不在本工作区或不可用 | 
| 409 | 构建器这一轮还在运行 | 

 
PUT`/api/kb/builder/sessions/{id}/draft`
 
保存右侧配置（upsert，整份覆盖）。照 `SaveAgentBuilderDraft`：配置原样存、服务端不解析，单份最大 512 KB（知识库自己的上限常量，是创建智能体 `maxAgentBuilderDraftBytes` 256 KB 的两倍，不改创建智能体的；防止前端出错时把这一行越写越大；默认 SCHEMA 全文约 8 KB）。

 
权限 发起人

 
请求体

```
{
  "draft": {                                                  // 右侧配置，服务端不解析
    "name": "支付排障手册",                                         // 名称
    "slug": "pay-troubleshoot",                               // slug
    "description": "支付、订单链路与排障步骤。",                           // 简介
    "purpose": "# 目标\n\n## 读者\n研发和测试……\n",                    // 目标
    "schema_mode": "default",                                 // 用户在右侧选的 Schema 模式；custom 时另有 schema 字段存 Schema
    "applied_message_id": "m_88f1"                            // 已应用到右侧的最后一条构建器回复，恢复时不重复覆盖
  }
}
```

 
| 状态码 | 情况 | 
| 400 | `draft` 缺失或不是合法 JSON | 
| 404 | 构建器会话不存在或不是自己的 | 
| 413 | 超过 512 KB | 

 
DELETE`/api/kb/builder/sessions/{id}`
 
放弃创建 / 配置：删除 `kb_builder_session`，再走现有删除聊天会话的逻辑（连同隐藏构建器智能体）。

 
权限 发起人

 
构建器回复的原文（默认模式）

```
好的，按你说的起草了：读者是研发和测试，收支付、订单链路的设计和排障步骤，不收需求文档。
Schema 用默认的。名称和简介在右侧，可以直接改。
<kb_draft>{"name":"支付排障手册","slug":"pay-troubleshoot","description":"支付、订单链路与排障步骤，给研发和测试用。","purpose":"# 目标\n\n## 读者\n研发和测试……\n"}</kb_draft>
```

|  | 处理 | 
| 前两行 | 对话里正常显示 | 
| 最后一行 `<kb_draft>…</kb_draft>` | 对话里不显示；前端解析里面的 JSON，填到右侧配置。照创建智能体：`9a7f600b6` `packages/core/agents/builder-protocol.ts` 的 `parseBuilderDraft`（L41）取出草稿、`stripBuilderDraft`（L131）从显示内容里去掉这一行，知识库照写一份 `kb_draft` 版 | 

最后一行里的 JSON · 默认模式

```
{
  "name": "支付排障手册",                                           // 名称
  "slug": "pay-troubleshoot",                                 // 建议的 slug，用户可改
  "description": "支付、订单链路与排障步骤，给研发和测试用。",                     // 简介
  "purpose": "# 目标\n\n## 读者\n研发和测试……\n"                       // 目标全文
}
```

最后一行里的 JSON · 自定义模式（多一个 schema）

```
{
  "name": "支付排障手册",                                           // 名称
  "slug": "pay-troubleshoot",                                 // 建议的 slug
  "description": "支付、订单链路与排障步骤，给研发和测试用。",                     // 简介
  "purpose": "# 目标\n\n## 读者\n研发和测试……\n",                      // 目标全文
  "schema": "# Schema\n\nThis file tells agents……\n"          // 只有自定义模式才有：构建器起草的 Schema 全文
}
```

POST`/api/kb/bases`
 
创建知识库。

 
权限 工作区成员

 
请求体

```
{
  "name": "支付排障手册",                                           // 必填
  "slug": "pay-troubleshoot",                                 // 必填：小写字母、数字、连字符，工作区内唯一；构建器会起草一个，用户可改（同创建工作区 workspace.go L244-253）
  "description": "支付、订单链路与排障步骤，给研发和测试用。",                     // 选填
  "purpose": "# 目标\n\n## 读者\n研发和测试……\n",                      // 选填
  "schema_mode": "default"                                    // 必填。default：服务端写入当时的内置模板，请求里不能带 schema；custom：请求必须带 schema（Schema 全文）
}
```

 
响应 201

```
{
  "id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",               // 知识库 id（UUID）
  "workspace_id": "ws_8f2a1c",                                // 工作区 id
  "name": "支付排障手册",                                           // 名称
  "slug": "pay-troubleshoot",                                 // 工作区内唯一，小写字母 / 数字 / 连字符；页面引用写 slug:/路径
  "description": "支付、订单链路与排障步骤，给研发和测试用。",                     // 简介；智能体据此判断要不要用这个知识库
  "schema_mode": "default",                                   // default 内置模板（只读）/ custom 自定义
  "created_by": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",       // 创建人
  "page_count": 0,                                            // 页面数
  "content_version": 0,                                       // 内容版本，每次合并 +1；ETag 和检索索引以它为准
  "created_at": "2026-10-26T09:20:00Z",                       // RFC3339
  "updated_at": "2026-10-26T09:20:00Z",                       // RFC3339
  "mention": "[支付排障手册](mention://kb/5b1f0c2e…)"               // 原样贴进回复，渲染成卡片（7.14）；示例里的 id 截短了
}
```

 
| 状态码 | 情况 | 
| 400 | 缺 name 或 slug；slug 格式不对；`default` 时带了 `schema`；`custom` 时没带 `schema` | 
| 409 | slug 在工作区内已存在 | 

 

#### 7.2 知识库首页与待处理

设计稿 · 2.1 首页 · 2.3–2.4 批注 · 2.5–2.6 需要复核

- 首页是知识库的数据总览：知识库信息、待处理、最近更新和运行中的作业，一次请求出首屏；不显示任何页面的正文（决策 103）。
- 待处理卡片：批注数（其中智能体上报的单独计数）、需要复核的页面数（过了 `stale_after`）、待审核数。
- 「最近更新」最多 5 条：取最近合并的变更请求改动的页面，同一页面只出现一次（取最近那次），按合并时间倒序；服务端固定截取，不开放参数。更早的记录在「变更记录」里看（7.3）。
- 「需要复核」点进页面时，本页的论断全部标黄，悬停显示核实时间和证据（2.6）。代码证据是否落后由健康检查的智能体判断，问题记成批注。
- 批注「全部交给智能体」：新建一个作业，`starter = annotations`，带上全部待处理批注（7.10）。

GET`/api/kb/bases/{kb}/home`
 
首页数据。

 
权限 工作区成员

 
响应 200

```
{
  "knowledge_base": {                                         // 知识库基本信息
    "id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",             // 知识库 id（UUID）
    "workspace_id": "ws_8f2a1c",                              // 工作区 id
    "name": "团队知识库",                                          // 名称
    "slug": "team",                                           // 工作区内唯一，小写字母 / 数字 / 连字符；页面引用写 slug:/路径
    "description": "订单、支付、发布与测试流程，团队共用的业务和系统知识。",             // 简介；智能体据此判断要不要用这个知识库
    "schema_mode": "default",                                 // default 内置模板（只读）/ custom 自定义
    "created_by": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",     // 创建人
    "page_count": 42,                                         // 页面数
    "content_version": 87,                                    // 内容版本，每次合并 +1；ETag 和检索索引以它为准
    "created_at": "2026-10-08T09:12:03Z",                     // RFC3339
    "updated_at": "2026-10-25T14:20:11Z"                      // RFC3339
  },
  "pending": {                                                // 待处理计数
    "annotations": 4,                                         // 待处理批注
    "agent_reported": 1,                                      // 其中智能体上报的
    "stale_pages": 2,                                         // 需要复核的页面
    "open_mrs": 1                                             // 待审核的变更请求
  },
  "recent": [                                                 // 最近合并影响的页面：最多 5 条，按合并时间倒序；同一页面只取最近一次
    {
      "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",      // 页面
      "path": "/payment/callback",                            // 路径
      "title": "支付回调",                                        // 标题
      "mr_number": 15,                                        // 变更请求编号
      "mr_title": "测试环境：部署时间改为 21:00",                        // 变更请求标题
      "merged_at": "2026-10-25T09:50:00Z"                     // 合并时间
    }
  ],
  "running_jobs": 1                                           // 运行中的作业数
}
```

 
GET`/api/kb/bases/{kb}/stale`
 
需要复核的页面。

 
权限 工作区成员

 
响应 200

```
[
  {
    "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",        // 页面
    "path": "/release/flow",                                  // 路径
    "title": "发布流程",                                          // 标题
    "stale_after": "2026-10-20T00:00:00Z",                    // 复核期
    "claims": 6                                               // 本页论断数
  }
]
```

 

#### 7.3 「…」菜单：变更记录、关系图、复制链接

设计稿 · 2.2 菜单 · 2.7–2.9 变更记录 · 2.10–2.11 关系图 · 2.12 复制链接

- 变更记录：已合并的变更请求；详情复用 7.9。回滚见 6.3。
- 关系图：节点是页面，边来自 `kb_link`；颜色按一级页面分组；没有入链的页面虚线圈；指向还没写的页面画成灰色虚线节点。
- 复制链接：前端拼 `/kb/{slug}` 写剪贴板，不调接口。

GET`/api/kb/merge-requests`
 
变更请求列表；变更记录传 `status=merged&kb=team`。

 
权限 工作区成员

 
| 参数 | 位置 | 类型 | 必填 | 说明 / 示例 | 
| `status` | query | string | 否 | `open`（默认）/ `merged` / `closed` / `all` | 
| `kb` | query | string | 否 | 只看某知识库，如 `team` | 
| `limit` | query | int | 否 | 默认 50，最大 100 | 

 
响应 200

```
[
  {
    "id": "e7f8a9b0-c1d2-4e3f-9a8b-7c6d5e4f3a2b",             // 变更请求 id（UUID）
    "number": 16,                                             // 工作区内编号，界面上的 #16
    "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 改动的知识库（一个变更请求只改一个知识库）
    "title": "去重键改为渠道交易号，补回调人工处理",                            // 标题
    "summary": "处理批注 a1b2c3d4：去重键改为渠道交易号，引用 MAR-142；新增「回调人工处理」。",  // 智能体的变更说明（含处理了哪些批注）
    "source": "annotations",                                  // 来源：ingest 收录资料 / health 健康检查 / merge 知识合并 / annotations 处理批注 / new_page 新页面 / revert 回滚 / custom 其他
    "status": "open",                                         // open / merged / closed
    "risk": "medium",                                         // low / medium / high
    "author_type": "agent",                                   // agent / member
    "author_id": "3a9e2b10-77c4-4d1f-9b2e-6f5d4c3b2a19",      // 作者 id
    "author_name": "通用开发助手",                                  // 作者显示名
    "draft_id": "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",       // 变更请求指向的草稿；评论后智能体继续改这份草稿，diff 随之刷新
    "draft_version": 9,                                       // 草稿版本，每次写入 +1；合并时带上，防止合并审核人没看过的改动
    "annotation_ids": [                                       // 本次处理的批注
      "a1b2c3d4-0000-4000-8000-000000000001"
    ],
    "origin": {                                               // 来源追溯：变更请求是从哪里发起的；判定顺序见 7.13 建变更请求接口
      "type": "kb_job",                                       // kb_job 知识库作业 / revert 回滚 / chat 对话 / autopilot_run 自动化运行 / issue 任务 / none 无来源，只显示作者
      "label": "知识库作业 · 处理批注",                                // 来源的显示文字
      "ref_id": "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f"        // 来源对象 id，用于跳转
    },
    "job_id": "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f",         // 关联的知识库作业（无则 null）
    "reverts": null,                                          // 回滚的变更请求编号（不是回滚为 null）
    "merged_by": null,                                        // 合并人（未合并为 null）
    "merged_at": null,                                        // 合并时间（未合并为 null）
    "closed_by": null,                                        // 关闭人（未关闭为 null）
    "closed_at": null,                                        // 关闭时间（未关闭为 null）
    "close_reason": "",                                       // 关闭理由（未关闭为空串）
    "created_at": "2026-10-25T10:31:00Z",                     // RFC3339
    "updated_at": "2026-10-25T10:41:00Z"                      // RFC3339
  }
]
```

 
POST`/api/kb/merge-requests/{number}/revert`
 
回滚一个已合并的变更请求，生成新的变更请求。

 
权限 知识库创建者或 owner / admin

 
响应 201

```
{
  "id": "e7f8a9b0-c1d2-4e3f-9a8b-7c6d5e4f3a2b",               // 变更请求 id（UUID）
  "number": 18,                                               // 工作区内编号，界面上的 #16
  "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 改动的知识库（一个变更请求只改一个知识库）
  "title": "Revert #15: 测试环境：部署时间改为 21:00",                   // 标题
  "summary": "处理批注 a1b2c3d4：去重键改为渠道交易号，引用 MAR-142；新增「回调人工处理」。",  // 智能体的变更说明（含处理了哪些批注）
  "source": "revert",                                         // 来源：ingest 收录资料 / health 健康检查 / merge 知识合并 / annotations 处理批注 / new_page 新页面 / revert 回滚 / custom 其他
  "status": "open",                                           // open / merged / closed
  "risk": "medium",                                           // low / medium / high
  "author_type": "agent",                                     // agent / member
  "author_id": "3a9e2b10-77c4-4d1f-9b2e-6f5d4c3b2a19",        // 作者 id
  "author_name": "通用开发助手",                                    // 作者显示名
  "draft_id": "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",         // 变更请求指向的草稿；评论后智能体继续改这份草稿，diff 随之刷新
  "draft_version": 1,                                         // 草稿版本，每次写入 +1；合并时带上，防止合并审核人没看过的改动
  "annotation_ids": [],                                       // 本次处理的批注
  "origin": {                                                 // 来源追溯：变更请求是从哪里发起的；判定顺序见 7.13 建变更请求接口
    "type": "revert",                                         // kb_job 知识库作业 / revert 回滚 / chat 对话 / autopilot_run 自动化运行 / issue 任务 / none 无来源，只显示作者
    "label": "回滚 #15",                                        // 来源的显示文字
    "ref_id": null                                            // 来源对象 id，用于跳转
  },
  "job_id": null,                                             // 关联的知识库作业（无则 null）
  "reverts": 15,                                              // 回滚的变更请求编号（不是回滚为 null）
  "merged_by": null,                                          // 合并人（未合并为 null）
  "merged_at": null,                                          // 合并时间（未合并为 null）
  "closed_by": null,                                          // 关闭人（未关闭为 null）
  "closed_at": null,                                          // 关闭时间（未关闭为 null）
  "close_reason": "",                                         // 关闭理由（未关闭为空串）
  "created_at": "2026-10-25T10:31:00Z",                       // RFC3339
  "updated_at": "2026-10-25T10:41:00Z"                        // RFC3339
}
```

 
| 状态码 | 情况 | 
| 409 | 原变更请求未合并；后续改动碰了同样的块（带 `conflicts`） | 

 
GET`/api/kb/bases/{kb}/graph`
 
关系图数据。

 
权限 工作区成员

 
响应 200

```
{
  "nodes": [                                                  // 页面
    {
      "id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",           // 页面 id；还没写的页面为 null
      "title": "支付回调",                                        // 标题（还没写的为路径）
      "group": "支付",                                          // 所属一级页面，决定颜色
      "degree": 3,                                            // 连接数，0 画虚线圈
      "missing": false                                        // 还没写的页面
    },
    {
      "id": null,                                             // 页面 id；还没写的页面为 null
      "title": "/payment/refund",                             // 标题（还没写的为路径）
      "group": "支付",                                          // 所属一级页面，决定颜色
      "degree": 1,                                            // 连接数，0 画虚线圈
      "missing": true                                         // 还没写的页面
    }
  ],
  "edges": [                                                  // 链接
    {
      "from": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",         // 发起链接的页面
      "to": "22334455-6677-4889-9aab-bccddeeff001"            // 被链接的页面
    }
  ]
}
```

 

#### 7.4 页面阅读

设计稿 · 3.1 阅读页 · 3.2 信息面板 · 3.3 目录 · 3.4 引用悬停 · 3.5 待审核提示 · 3.6 页面菜单

- 读 `kb_page` 一行；传 `draft` 时读这份草稿里的版本（只有草稿发起人可看，决策 22）。
- 块里的 `kb://` 链接在返回前换成前端路由；目录从 heading 块生成。
- 引用悬停卡片用 `sources`；对话来源 `openable` 按现有聊天的可见规则判断（决策 33）。
- 原始文件引用可以点开（决策 72，设计稿 3.7–3.8）：悬停卡片显示文件名、上传人、日期和页码，点「打开文件」用现有附件预览弹窗打开（任务、评论里的附件就是这个组件，PDF 和图片可以直接看，其他格式提供下载），PDF 带 `#page=` 时直接翻到那一页。正文里的脚注、页面信息面板的来源列表、原始资料标签页的每一行，点开都是同一个预览。文件内容走下面的 `GET /api/kb/raw/{id}/content`。
- 「本页有待审核的修改」：查草稿里包含本页、且有 open 变更请求的草稿（3.5）。
- 页面菜单「让智能体检查本页」：新建一个作业，`starter = health`，带上本页。

GET`/api/kb/pages/{id}`
 
读一个页面。`{id}` 也可以是 `team:/payment/callback` 形式的引用。

 
权限 工作区成员；`draft` 只对草稿发起人

 
| 参数 | 位置 | 类型 | 必填 | 说明 / 示例 | 
| `draft` | query | uuid | 否 | 草稿 id，如 `9d8c7b6a-…`。带上后返回这份草稿里改过的版本；草稿没改这页就返回主线版本。只有草稿发起人能用 | 

 
响应 200

```
{
  "id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",               // 页面 id
  "path": "/payment/callback",                                // 当前路径
  "version": "44556677-8899-4aab-9ccd-deeff0011223",          // 修订 id（草稿为 d9）
  "breadcrumb": [                                             // 祖先页面
    {
      "id": "11223344-5566-4778-8899-aabbccddeeff",           // 页面 id
      "title": "支付"                                           // 标题
    }
  ],
  "frontmatter": {                                            // 页头
    "type": "Workflow",                                       // 类型
    "title": "支付回调",                                          // 标题
    "description": "渠道异步回调的接收、去重与失败处理",                       // 一句话说明
    "tags": [                                                 // 标签
      "dev",
      "qa"
    ],
    "status": "stable",                                       // 生命周期
    "stale_after": "2027-01-20T00:00:00Z"                     // 复核期
  },
  "blocks": [                                                 // 正文块
    {
      "id": "b8Xz",                                           // 页面 id
      "kind": "text",                                         // 块里是块类型（目前只有 text）；sources 里是来源类型 task / chat / pr / repo / raw / web
      "content": "按渠道交易号去重。[^mar-142]"                        // 块内容：一段 Markdown（链接已换成路由）
    }
  ],
  "sources": [                                                // 引用来源（由论断生成）
    {
      "id": "mar-142",                                        // 页面 id
      "kind": "task",                                         // 块里是块类型（目前只有 text）；sources 里是来源类型 task / chat / pr / repo / raw / web
      "uri": "task://MAR-142",                                // 地址
      "title": "回调改用渠道交易号去重",                                 // 标题
      "openable": true                                        // 当前用户能否打开
    },
    {
      "id": "channel-v3",                                     // 页面 id
      "kind": "raw",                                          // 块里是块类型（目前只有 text）；sources 里是来源类型 task / chat / pr / repo / raw / web
      "uri": "raw://sources/channel-v3.pdf#page=12",          // 地址
      "title": "渠道接入规范 v3 · 第 12 页",                          // 标题
      "openable": true                                        // 当前用户能否打开
    }
  ],
  "claims": [                                                 // 论断位置（「需要复核」标黄用）
    {
      "key": "c2",                                            // 编号
      "block_id": "b8Xz",                                     // 所在块
      "checked_at": "2026-10-25T10:28:00Z"                    // 核实时间
    }
  ],
  "last_mr": {                                                // 最近一次合并
    "number": 15,                                             // 变更请求编号
    "author_name": "通用开发助手",                                  // 作者
    "merged_at": "2026-10-25T09:50:00Z"                       // 合并时间
  },
  "backlinks": [                                              // 链接到本页的页面
    {
      "id": "22334455-6677-4889-9aab-bccddeeff001",           // 页面 id
      "title": "幂等键"                                          // 标题
    }
  ],
  "pending_mr": {                                             // 涉及本页的待审核变更请求（无则 null）
    "number": 16,                                             // 变更请求编号
    "title": "去重键改为渠道交易号，补回调人工处理"                             // 标题
  },
  "annotations_open": 2                                       // 本页待处理批注数
}
```

 

#### 7.5 页面树

设计稿 · 4.1 悬停出现＋ · 4.2–4.3 让智能体在这里写一页

照飞书 `wiki +node-list`：一次只列一级，带 `has_child`，要看下一级再按父页面取。游标翻页：按排序键返回，每页最多 200 条；还有下一页时带 `next_cursor`，传回 `cursor` 接着取，直到为空串，就拿到了这一级完整的目录（子页面不展开，只给 `has_child` 和 `child_count`），相当于原来的 index.md，据此决定往哪钻（决策 94，修正决策 79 的不分页）。界面和智能体用同一个接口（决策 60）。

- 界面：页面树初始只取顶层；展开节点时取它的子级；一级超过 200 页时，滚动到底再用 `next_cursor` 取下一页。打开某个页面时，按阅读接口返回的 `breadcrumb` 并发取各级祖先的子级，把树展开到当前页。
- 智能体：`marvis kb page list team` 看顶层，`--parent team:/payment` 往下钻，输出有 `next_cursor` 时用 `--cursor` 取完这一级；找具体内容优先 `marvis kb search`，不需要遍历。导出时每个目录的 `index.md` 也是按这一级的输出生成的。
- 查询：`WHERE knowledge_base_id = ? AND parent_id IS NOT DISTINCT FROM ? AND deleted_at IS NULL AND (position, id) > (游标里的 position, id) ORDER BY position, id LIMIT 201`（键集分页，多取 1 条判断有没有下一页；游标是 position 和 id 的不透明编码），走 `kb_page_parent_idx`；`has_child` / `child_count` 对这一页的页面用同一索引一次 `GROUP BY parent_id` 批量算出，不逐页查。
- 「＋」新页面：新建一个作业，`starter = new_page`，`page_id` 为所在页面，首条消息预填「在『支付』下新增一页：……」（4.3）。
- 传 `draft` 时叠加草稿：这一级里新建、修改、移动、删除的页面带标记；先叠加草稿再按排序键分页，翻页时页面不会重复或漏掉。

GET`/api/kb/bases/{kb}/pages`
 
列出某一级页面。

 
权限 工作区成员

 
| 参数 | 位置 | 类型 | 必填 | 说明 / 示例 | 
| `parent` | query | string | 否 | 父页面 id 或 `team:/payment`；不传为顶层 | 
| `cursor` | query | string | 否 | 上一页返回的 `next_cursor`；不传从第一条开始 | 
| `limit` | query | int | 否 | 每页条数，1–200，默认 200 | 
| `type` | query | string | 否 | 页面类型，同 Schema 里的 `type`；带上时列出这一类的全部页面，不再只列一层：范围是整个知识库，带 `parent` 时是该页下面的所有后代，按路径排序，游标翻页；页面树不用它 | 
| `draft` | query | uuid | 否 | 草稿 id，如 `9d8c7b6a-…`。带上后按这份草稿里的样子列：草稿新建、移到这一级的页面也列出，草稿删掉的仍列出并标 `deleted`；不带只列主线。界面上发起人看自己的草稿时，用它画页面树的「草稿 · 新 / 改 / 删」标记；智能体用它看到自己在草稿里刚建的页面，避免重复新建 | 

 
响应 200

```
{
  "version": 87,                                              // content_version
  "parent": {                                                 // 父页面（顶层为 null）
    "id": "11223344-5566-4778-8899-aabbccddeeff",             // 页面 id
    "path": "/payment",                                       // 路径
    "title": "支付"                                             // 标题
  },
  "pages": [                                                  // 这一级的页面，按排序键，最多 limit 条
    {
      "id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",           // 页面 id
      "path": "/payment/callback",                            // 路径
      "title": "支付回调",                                        // 标题
      "type": "Workflow",                                     // 类型
      "description": "渠道异步回调的接收、去重与失败处理",                     // 一句话说明
      "has_child": true,                                      // 有没有子页面（决定显示展开箭头）
      "child_count": 2,                                       // 子页面数
      "stale": true,                                          // 需要复核（树上黄点）
      "open_annotations": 2,                                  // 待处理批注数
      "draft_change": "modified"                              // 请求带 draft 时，这份草稿对这一页做了什么：added / modified / moved / deleted；没动或没带 draft 为空串（页面树上显示「草稿 · 新」等标签）
    },
    {
      "id": "33445566-7788-499a-8bbc-cddeeff00112",           // 页面 id
      "path": "/payment/callback-manual",                     // 路径
      "title": "回调人工处理",                                      // 标题
      "type": "Workflow",                                     // 类型
      "description": "回调失败后如何人工补单",                           // 一句话说明
      "has_child": false,                                     // 有没有子页面（决定显示展开箭头）
      "child_count": 0,                                       // 子页面数
      "stale": false,                                         // 需要复核（树上黄点）
      "open_annotations": 0,                                  // 待处理批注数
      "draft_change": "added"                                 // 请求带 draft 时，这份草稿对这一页做了什么：added / modified / moved / deleted；没动或没带 draft 为空串（页面树上显示「草稿 · 新」等标签）
    }
  ],
  "total": 2,                                                 // 符合条件的页面总数，不含已删除；带 draft 时按叠加草稿后计数
  "next_cursor": ""                                           // 还有下一页时为游标，传给 cursor 接着取；取完为空串
}
```

 

#### 7.6 批注

设计稿 · 5.1 划选一句 · 5.2 写批注 · 5.3–5.4 本页批注 · 5.5–5.6 知识库批注 · 5.7 原句改写或删除

- 三种挂法（决策 9）：一句（`page_id` + `block_id` + `quote`）、本页（只有 `page_id`）、整个知识库（都为空）。
- 定位：先在原块里找原句；块被删或原句不在了，用前后 32 字在全页模糊匹配；仍找不到则 `anchor_lost = true`，界面退为整页批注（5.7）。
- 状态：提交变更请求时关联的批注 → processing；合并 → resolved；关闭 → 退回 pending。智能体上报的缺口也是一条知识库级批注（决策 16）。

POST`/api/kb/bases/{kb}/annotations`
 
新建批注。

 
权限 工作区成员

 
请求体

```
{
  "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",          // 选填；不传 = 整个知识库
  "block_id": "b8Xz",                                         // 挂在某一句时必填
  "quote": "渠道回调按订单号加幂等键去重。",                                 // 挂在某一句时必填
  "prefix": "## 去重\n",                                        // 原句前 32 字
  "suffix": "幂等键在 Redis 中保存 24 小时",                           // 原句后 32 字
  "body": "去重键已经改成渠道交易号，不是订单号。"                               // 必填
}
```

 
响应 201

```
{
  "id": "a1b2c3d4-0000-4000-8000-000000000001",               // 批注 id
  "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 知识库 id
  "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",          // 挂在哪一页；null 表示挂在整个知识库
  "page_path": "/payment/callback",                           // 页面当前路径（知识库级为空串）
  "page_title": "支付回调",                                       // 页面标题（知识库级为空串）
  "block_id": "b8Xz",                                         // 原句所在的块（整页 / 整库为空串）
  "quote": "渠道回调按订单号加幂等键去重。",                                 // 挂在某一句时为原句，整页 / 整库为空串
  "prefix": "## 去重\n",                                        // 原句前 32 字，用于改写后重新定位
  "suffix": "幂等键在 Redis 中保存 24 小时",                           // 原句后 32 字
  "body": "去重键已经改成渠道交易号，不是订单号。",                              // 批注内容
  "author_type": "member",                                    // member / agent
  "author_id": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",        // 作者 id
  "author_name": "王芳",                                        // 作者显示名
  "status": "pending",                                        // pending 待处理 / processing 处理中 / resolved 已处理 / dismissed 不处理
  "anchor_lost": false,                                       // 原句已不在页面中，界面退为整页批注
  "merge_request_id": null,                                   // 正在处理它的变更请求（无则 null）
  "mr_number": null,                                          // 变更请求编号（无则 null）
  "created_at": "2026-10-24T17:40:00Z",                       // RFC3339
  "updated_at": "2026-10-24T17:40:00Z"                        // RFC3339
}
```

 
| 状态码 | 情况 | 
| 400 | 页面不在本知识库；传了 quote 没传 page_id / block_id | 

 
GET`/api/kb/bases/{kb}/annotations`
 
批注列表。

 
权限 工作区成员

 
| 参数 | 位置 | 类型 | 必填 | 说明 / 示例 | 
| `status` | query | string | 否 | 默认 `pending`；`all` 不过滤 | 
| `page` | query | string | 否 | 只看某页；`-` 只看知识库级 | 

 
响应 200

```
[
  {
    "id": "a1b2c3d4-0000-4000-8000-000000000001",             // 批注 id
    "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 知识库 id
    "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",        // 挂在哪一页；null 表示挂在整个知识库
    "page_path": "/payment/callback",                         // 页面当前路径（知识库级为空串）
    "page_title": "支付回调",                                     // 页面标题（知识库级为空串）
    "block_id": "b8Xz",                                       // 原句所在的块（整页 / 整库为空串）
    "quote": "渠道回调按订单号加幂等键去重。",                               // 挂在某一句时为原句，整页 / 整库为空串
    "prefix": "## 去重\n",                                      // 原句前 32 字，用于改写后重新定位
    "suffix": "幂等键在 Redis 中保存 24 小时",                         // 原句后 32 字
    "body": "去重键已经改成渠道交易号，不是订单号。",                            // 批注内容
    "author_type": "member",                                  // member / agent
    "author_id": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",      // 作者 id
    "author_name": "王芳",                                      // 作者显示名
    "status": "pending",                                      // pending 待处理 / processing 处理中 / resolved 已处理 / dismissed 不处理
    "anchor_lost": false,                                     // 原句已不在页面中，界面退为整页批注
    "merge_request_id": null,                                 // 正在处理它的变更请求（无则 null）
    "mr_number": null,                                        // 变更请求编号（无则 null）
    "created_at": "2026-10-24T17:40:00Z",                     // RFC3339
    "updated_at": "2026-10-24T17:40:00Z"                      // RFC3339
  }
]
```

 
PATCH`/api/kb/annotations/{id}`
 
标为不处理 / 恢复待处理。

 
权限 作者或 owner / admin

 
请求体

```
{
  "status": "dismissed"                                       // dismissed / pending
}
```

 
响应 200

```
{
  "id": "a1b2c3d4-0000-4000-8000-000000000001",               // 批注 id
  "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 知识库 id
  "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",          // 挂在哪一页；null 表示挂在整个知识库
  "page_path": "/payment/callback",                           // 页面当前路径（知识库级为空串）
  "page_title": "支付回调",                                       // 页面标题（知识库级为空串）
  "block_id": "b8Xz",                                         // 原句所在的块（整页 / 整库为空串）
  "quote": "渠道回调按订单号加幂等键去重。",                                 // 挂在某一句时为原句，整页 / 整库为空串
  "prefix": "## 去重\n",                                        // 原句前 32 字，用于改写后重新定位
  "suffix": "幂等键在 Redis 中保存 24 小时",                           // 原句后 32 字
  "body": "去重键已经改成渠道交易号，不是订单号。",                              // 批注内容
  "author_type": "member",                                    // member / agent
  "author_id": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",        // 作者 id
  "author_name": "王芳",                                        // 作者显示名
  "status": "dismissed",                                      // pending 待处理 / processing 处理中 / resolved 已处理 / dismissed 不处理
  "anchor_lost": false,                                       // 原句已不在页面中，界面退为整页批注
  "merge_request_id": null,                                   // 正在处理它的变更请求（无则 null）
  "mr_number": null,                                          // 变更请求编号（无则 null）
  "created_at": "2026-10-24T17:40:00Z",                       // RFC3339
  "updated_at": "2026-10-24T17:40:00Z"                        // RFC3339
}
```

 
| 状态码 | 情况 | 
| 409 | 批注处于 processing / resolved | 

 

#### 7.7 搜索

设计稿 · 6.1 搜索结果 · 6.2 没有结果

混合检索：关键字一路和向量一路各取前 50 个块，用 Reciprocal Rank Fusion 融合，按页面聚合（决策 100）。做法照 pgvector README「Hybrid Search」：全文检索加向量检索，用 RRF 或 cross-encoder 合并结果。

- 关键字一路照抄任务检索（`9a7f600b6` `server/internal/handler/search.go`）：`kb_page` 存一列 `search_text`（标题 + 块的纯文本，写入时生成），建 pg_bigm GIN 索引（扩展缺失时退到 pg_trgm，写法同迁移 032 / 137），`LOWER(search_text) LIKE` 查询并带语句超时；命中页面后在应用里扫这一页的块找出命中块。标题命中的块排在正文命中前面。中文用 pg_bigm 比 Postgres 自带全文检索准，所以关键字一路不换成 `tsvector`。
- 向量一路：查询词先调 embedding 拿向量（2 秒超时），再在 `kb_block_embedding` 上按余弦距离取前 50 块，过滤工作区和知识库。带过滤条件时按 pgvector README「Iterative Index Scans」：`SET LOCAL hnsw.iterative_scan = relaxed_order`，外面套一层 materialized CTE 恢复严格排序，避免过滤后结果不足。
- 融合：每个块的分数 = Σ 1 / (60 + 该块在这一路的名次)，两路都有的块得分相加；按页面聚合，每页取得分最高的块作为命中块，再截取 `limit` 条。
- 降级：没配置 embedding 模型、调用失败或超时，只用关键字一路，响应的 `mode` 为 `keyword`；正常时为 `hybrid`。
- 建向量：变更请求合并后异步计算，不放在合并事务里。只算主线里内容变了的块（比对 `content_hash`），按批调用 embedding 接口（一次最多 100 块），失败按指数退避重试；页面删除时删掉它的向量。第一次配置模型或换模型后，后台任务按知识库分批补算存量块。草稿不建向量，和关键字一路一样只搜主线。
- embedding 单独配置，不和对话模型共用：新增 `MARVIS_EMBEDDING_BASE_URL`、`MARVIS_EMBEDDING_API_KEY`、`MARVIS_EMBEDDING_MODEL`（写进 `.env.example` 和 `docker-compose.selfhost.yml`），三个都配了才启用向量一路。客户端放在新包 `server/pkg/embedding`，调用 OpenAI 兼容的 `/v1/embeddings`，不改 `server/pkg/llm`。请求带 `dimensions: 1024`，和表的 `vector(1024)` 对应；OpenAI text-embedding-3、通义 text-embedding-v3、bge-m3 都能输出 1024 维。
- 没有结果只显示「没有找到」，不记缺口（决策 16）。

GET`/api/kb/search`
 
检索。

 
权限 工作区成员

 
| 参数 | 位置 | 类型 | 必填 | 说明 / 示例 | 
| `q` | query | string | 是 | `回调 去重` | 
| `kb` | query | string | 否 | 只搜某知识库 | 
| `type` | query | string | 否 | 按页面类型过滤，同 Schema 里的 `type`，如 `Runbook` | 
| `limit` | query | int | 否 | 1–50，默认 10；按相关度返回前 `limit` 条，不翻页 | 

 
响应 200

```
{
  "mode": "hybrid",                                           // hybrid 关键字 + 向量 / keyword 只用了关键字（没配模型或向量一路失败）
  "total": 1,                                                 // 命中的页面总数
  "hits": [                                                   // 命中，按得分排序；没有结果为空数组
    {
      "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",      // 页面
      "slug": "team",                                         // 知识库
      "path": "/payment/callback",                            // 路径
      "title": "支付回调",                                        // 标题
      "block_id": "b8Xz",                                     // 命中的块
      "excerpt": "渠道回调按渠道交易号加幂等键去重……",                        // 命中片段
      "score": 0.0325                                         // RRF 融合分，只用于排序
    }
  ]
}
```

 

#### 7.8 页面历史

设计稿 · 7.1 历史 · 7.2 查看一次修改 · 7.3 回滚确认

- 单页历史读 `kb_page_revision`，每条关联到合并它的变更请求。
- 查看一次修改：相邻两个修订的块渲染成 Markdown 后做行级 diff。
- 回滚：同 7.3，回滚的是整个变更请求。

GET`/api/kb/pages/{id}/history`
 
单页历史。

 
权限 工作区成员

 
响应 200

```
[
  {
    "revision_id": "44556677-8899-4aab-9ccd-deeff0011223",    // 修订
    "mr_number": 14,                                          // 变更请求编号（建库初始修订为 null）
    "mr_title": "每日收录 · 10-24",                               // 标题
    "source": "ingest",                                       // 来源
    "author_name": "通用开发助手",                                  // 作者
    "merged_by_name": "韩梅梅",                                  // 合并人
    "merged_at": "2026-10-24T22:06:00Z",                      // 合并时间
    "added": 3,                                               // 本页新增行数
    "deleted": 1                                              // 本页删除行数
  }
]
```

 

#### 7.9 变更审核

设计稿 · 8.1 待审核 · 8.2 详情 · 8.3 加入评论 · 8.4–8.5 评论后智能体修改 · 8.6 冲突 · 8.7 关闭确认 · 8.8 成员视角

- 详情：草稿里每个改动页一张文件卡片（GitLab MR 式，可折叠），基准修订与草稿的块渲染成 Markdown 后做行级 diff；open 状态每次打开都和当前主线试合并，冲突报到块和行（决策 23）。
- 检查：格式检查只看改动的页面（4.7）。
- 评论照任务评论做（决策 26、39）：底部常驻评论框；选中 diff 的一行「加入评论」带引用；默认由作者智能体接手，@ 了谁就启动谁。判定复用任务评论的规则（`server/internal/handler/comment.go:2633` `computeCommentAgentTriggers`，@ 解析 `server/internal/util/mention.go:16`），在知识库服务里实现，不改任务评论代码。
- 知识库作业中合并按钮不可用；合并、回滚、关闭要知识库创建者或 owner / admin，作者也能关闭自己的（决策 30、46、102），按令牌绑定的人判角色（`server/internal/middleware/workspace.go:240-260`）。

```
sequenceDiagram
  participant U as 审核人
  participant API as KB API
  participant CHAT as 聊天服务
  participant AG as 作者智能体
  U->>API: POST /merge-requests/16/comments（引用块 b8Xz）
  API->>API: 判定接手的智能体：@ 了谁就是谁，否则是作者
  alt 变更请求来自知识库作业
    API->>CHAT: 把评论（8.6 模板）作为一条消息发进原作业的对话
    CHAT->>AG: 派任务（任务令牌），草稿是原作业关联的那份
  else 来自对话 / 自动化 / 任务
    API->>AG: 照任务评论的规则派任务（任务令牌），不新建作业
  end
  AG->>API: page fetch → page patch --draft（草稿版本 +1）
  API-->>U: kb.mr.updated（diff 刷新）
  AG->>API: kb mr comment 16 --parent …
```

图 5 · 审核评论后智能体就地修改
GET`/api/kb/merge-requests/{number}`
 
变更请求详情。

 
权限 工作区成员

 
响应 200

```
{
  "id": "e7f8a9b0-c1d2-4e3f-9a8b-7c6d5e4f3a2b",               // 变更请求 id（UUID）
  "number": 16,                                               // 工作区内编号，界面上的 #16
  "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 改动的知识库（一个变更请求只改一个知识库）
  "title": "去重键改为渠道交易号，补回调人工处理",                              // 页面标题
  "summary": "处理批注 a1b2c3d4：去重键改为渠道交易号，引用 MAR-142；新增「回调人工处理」。",  // 智能体的变更说明（含处理了哪些批注）
  "source": "annotations",                                    // 来源：ingest 收录资料 / health 健康检查 / merge 知识合并 / annotations 处理批注 / new_page 新页面 / revert 回滚 / custom 其他
  "status": "open",                                           // open / merged / closed
  "risk": "medium",                                           // low / medium / high
  "author_type": "agent",                                     // agent / member
  "author_id": "3a9e2b10-77c4-4d1f-9b2e-6f5d4c3b2a19",        // 作者 id
  "author_name": "通用开发助手",                                    // 作者显示名
  "draft_id": "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",         // 变更请求指向的草稿；评论后智能体继续改这份草稿，diff 随之刷新
  "draft_version": 9,                                         // 草稿版本，每次写入 +1；合并时带上，防止合并审核人没看过的改动
  "annotation_ids": [                                         // 本次处理的批注
    "a1b2c3d4-0000-4000-8000-000000000001"
  ],
  "origin": {                                                 // 来源追溯：变更请求是从哪里发起的；判定顺序见 7.13 建变更请求接口
    "type": "kb_job",                                         // kb_job 知识库作业 / revert 回滚 / chat 对话 / autopilot_run 自动化运行 / issue 任务 / none 无来源，只显示作者
    "label": "知识库作业 · 处理批注",                                  // 来源的显示文字
    "ref_id": "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f"          // 来源对象 id，用于跳转
  },
  "job_id": "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f",           // 关联的知识库作业（无则 null）
  "reverts": null,                                            // 回滚的变更请求编号（不是回滚为 null）
  "merged_by": null,                                          // 合并人（未合并为 null）
  "merged_at": null,                                          // 合并时间（未合并为 null）
  "closed_by": null,                                          // 关闭人（未关闭为 null）
  "closed_at": null,                                          // 关闭时间（未关闭为 null）
  "close_reason": "",                                         // 关闭理由（未关闭为空串）
  "created_at": "2026-10-25T10:31:00Z",                       // RFC3339
  "updated_at": "2026-10-25T10:41:00Z",                       // RFC3339
  "pages": [                                                  // 改动的页面（GitLab MR 式文件卡片，每页一张）
    {
      "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",      // 页面 id（新建页面为草稿里分配的 id）
      "path": "/payment/callback",                            // 当前路径
      "old_path": "",                                         // 移动前路径（没移动为空串）
      "title": "支付回调",                                        // 页面标题
      "change": "modified",                                   // added / modified / moved / deleted
      "added": 2,                                             // 新增行数
      "deleted": 1,                                           // 删除行数
      "lines": [                                              // diff 行（块渲染成 Markdown 后逐行比较）
        {
          "kind": "context",                                  // context / add / delete
          "text": "## 去重",                                    // 行内容
          "block_id": "b7Kq",                                 // 行所在的块；「加入评论」带上它
          "old_line": 14,                                     // 基准版本行号（新增行为 0）
          "new_line": 14                                      // 草稿行号（删除行为 0）
        },
        {
          "kind": "delete",                                   // context / add / delete
          "text": "渠道回调按订单号加幂等键去重。[^mar-98]",                 // 行内容
          "block_id": "b8Xz",                                 // 行所在的块；「加入评论」带上它
          "old_line": 15,                                     // 基准版本行号（新增行为 0）
          "new_line": 0                                       // 草稿行号（删除行为 0）
        },
        {
          "kind": "add",                                      // context / add / delete
          "text": "渠道回调按渠道交易号加幂等键去重。[^mar-142]",              // 行内容
          "block_id": "b8Xz",                                 // 行所在的块；「加入评论」带上它
          "old_line": 0,                                      // 基准版本行号（新增行为 0）
          "new_line": 15                                      // 草稿行号（删除行为 0）
        },
        {
          "kind": "add",                                      // context / add / delete
          "text": "自 10 月 20 日起生效。[^mar-142]",                // 行内容
          "block_id": "bR2m",                                 // 行所在的块；「加入评论」带上它
          "old_line": 0,                                      // 基准版本行号（新增行为 0）
          "new_line": 16                                      // 草稿行号（删除行为 0）
        }
      ]
    },
    {
      "page_id": "33445566-7788-499a-8bbc-cddeeff00112",      // 页面 id（新建页面为草稿里分配的 id）
      "path": "/payment/callback-manual",                     // 当前路径
      "old_path": "",                                         // 移动前路径（没移动为空串）
      "title": "回调人工处理",                                      // 页面标题
      "change": "added",                                      // added / modified / moved / deleted
      "added": 1,                                             // 新增行数
      "deleted": 0,                                           // 删除行数
      "lines": [                                              // diff 行（块渲染成 Markdown 后逐行比较）
        {
          "kind": "add",                                      // context / add / delete
          "text": "# 回调人工处理",                                 // 行内容
          "block_id": "bA01",                                 // 行所在的块；「加入评论」带上它
          "old_line": 0,                                      // 基准版本行号（新增行为 0）
          "new_line": 1                                       // 草稿行号（删除行为 0）
        }
      ]
    }
  ],
  "checks": {                                                 // 提交前检查
    "lint": [                                                 // 格式检查（只看改动的页面）
      {
        "code": "orphan_page",                                // 规则编号
        "severity": "warning",                                // error / warning
        "page_id": "33445566-7788-499a-8bbc-cddeeff00112",    // 页面 id（新建页面为草稿里分配的 id）
        "path": "/payment/callback-manual",                   // 当前路径
        "message": "没有其他页面链接到这一页"                             // 说明
      }
    ],
    "conflicts": [                                            // 与主线冲突的块
      {
        "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",    // 页面 id（新建页面为草稿里分配的 id）
        "path": "/payment/callback",                          // 当前路径
        "block_id": "b8Xz",                                   // 行所在的块；「加入评论」带上它
        "main_lines": "15-15",                                // 主线上冲突的行范围
        "draft_lines": "15-16"                                // 草稿里冲突的行范围
      }
    ]
  }
}
```

 
GET`/api/kb/merge-requests/{number}/comments`
 
评论。

 
权限 工作区成员

 
响应 200

```
[
  {
    "id": "c9d8e7f6-a5b4-4c3d-9e2f-1a0b9c8d7e6f",             // 评论 id
    "merge_request_id": "e7f8a9b0-c1d2-4e3f-9a8b-7c6d5e4f3a2b",  // 变更请求
    "parent_id": null,                                        // 回复的评论（无则 null）
    "quote": {                                                // 引用的行（「加入评论」带入；不引用为 null）
      "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",      // 页面
      "block_id": "b8Xz",                                     // 块
      "text": "渠道回调按渠道交易号加幂等键去重。[^mar-142]"                   // 行内容
    },
    "body": "补一下改成交易号的原因和生效时间。",                              // Markdown，可含 [@名字](mention://agent/id)
    "author_type": "member",                                  // member / agent
    "author_id": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",      // 作者
    "author_name": "王芳",                                      // 作者显示名
    "triggered": [                                            // 这条评论启动的智能体（照任务评论规则）
      {
        "agent_id": "3a9e2b10-77c4-4d1f-9b2e-6f5d4c3b2a19",   // 智能体
        "agent_name": "通用开发助手",                               // 名称
        "reason": "author"                                    // author 变更请求作者 / mention 被 @
      }
    ],
    "created_at": "2026-10-25T10:38:00Z"                      // RFC3339
  }
]
```

 
POST`/api/kb/merge-requests/{number}/comments`
 
发评论；按规则启动智能体。

 
权限 工作区成员

 
请求体

```
{
  "parent_id": null,                                          // 回复某条评论时填
  "quote": {                                                  // 选填，引用的行
    "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",        // 页面
    "block_id": "b8Xz",                                       // 块
    "text": "渠道回调按渠道交易号加幂等键去重。[^mar-142]"                     // 行内容
  },
  "body": "补一下改成交易号的原因和生效时间。"                                 // 必填
}
```

 
响应 201

```
{
  "id": "c9d8e7f6-a5b4-4c3d-9e2f-1a0b9c8d7e6f",               // 评论 id
  "merge_request_id": "e7f8a9b0-c1d2-4e3f-9a8b-7c6d5e4f3a2b",  // 变更请求
  "parent_id": null,                                          // 回复的评论（无则 null）
  "quote": {                                                  // 引用的行（「加入评论」带入；不引用为 null）
    "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",        // 页面
    "block_id": "b8Xz",                                       // 块
    "text": "渠道回调按渠道交易号加幂等键去重。[^mar-142]"                     // 行内容
  },
  "body": "补一下改成交易号的原因和生效时间。",                                // Markdown，可含 [@名字](mention://agent/id)
  "author_type": "member",                                    // member / agent
  "author_id": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",        // 作者
  "author_name": "王芳",                                        // 作者显示名
  "triggered": [                                              // 这条评论启动的智能体（照任务评论规则）
    {
      "agent_id": "3a9e2b10-77c4-4d1f-9b2e-6f5d4c3b2a19",     // 智能体
      "agent_name": "通用开发助手",                                 // 名称
      "reason": "author"                                      // author 变更请求作者 / mention 被 @
    }
  ],
  "created_at": "2026-10-25T10:38:00Z"                        // RFC3339
}
```

 
POST`/api/kb/merge-requests/{number}/merge`
 
合并（6.3）。

 
权限 知识库创建者或 owner / admin（人或其智能体）

 
请求体

```
{
  "draft_version": 9                                          // 打开详情时的草稿版本
}
```

 
响应 200

```
{
  "id": "e7f8a9b0-c1d2-4e3f-9a8b-7c6d5e4f3a2b",               // 变更请求 id（UUID）
  "number": 16,                                               // 工作区内编号，界面上的 #16
  "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 改动的知识库（一个变更请求只改一个知识库）
  "title": "去重键改为渠道交易号，补回调人工处理",                              // 标题
  "summary": "处理批注 a1b2c3d4：去重键改为渠道交易号，引用 MAR-142；新增「回调人工处理」。",  // 智能体的变更说明（含处理了哪些批注）
  "source": "annotations",                                    // 来源：ingest 收录资料 / health 健康检查 / merge 知识合并 / annotations 处理批注 / new_page 新页面 / revert 回滚 / custom 其他
  "status": "merged",                                         // open / merged / closed
  "risk": "medium",                                           // low / medium / high
  "author_type": "agent",                                     // agent / member
  "author_id": "3a9e2b10-77c4-4d1f-9b2e-6f5d4c3b2a19",        // 作者 id
  "author_name": "通用开发助手",                                    // 作者显示名
  "draft_id": "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",         // 变更请求指向的草稿；评论后智能体继续改这份草稿，diff 随之刷新
  "draft_version": 9,                                         // 草稿版本，每次写入 +1；合并时带上，防止合并审核人没看过的改动
  "annotation_ids": [                                         // 本次处理的批注
    "a1b2c3d4-0000-4000-8000-000000000001"
  ],
  "origin": {                                                 // 来源追溯：变更请求是从哪里发起的；判定顺序见 7.13 建变更请求接口
    "type": "kb_job",                                         // kb_job 知识库作业 / revert 回滚 / chat 对话 / autopilot_run 自动化运行 / issue 任务 / none 无来源，只显示作者
    "label": "知识库作业 · 处理批注",                                  // 来源的显示文字
    "ref_id": "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f"          // 来源对象 id，用于跳转
  },
  "job_id": "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f",           // 关联的知识库作业（无则 null）
  "reverts": null,                                            // 回滚的变更请求编号（不是回滚为 null）
  "merged_by": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",        // 合并人（未合并为 null）
  "merged_at": "2026-10-25T11:02:00Z",                        // 合并时间（未合并为 null）
  "closed_by": null,                                          // 关闭人（未关闭为 null）
  "closed_at": null,                                          // 关闭时间（未关闭为 null）
  "close_reason": "",                                         // 关闭理由（未关闭为空串）
  "created_at": "2026-10-25T10:31:00Z",                       // RFC3339
  "updated_at": "2026-10-25T10:41:00Z"                        // RFC3339
}
```

 
| 状态码 | 情况 | 
| 403 | 没有权限 | 
| 409 | 不是 open；草稿在打开后又变了；与主线冲突（带 `conflicts`，先 `kb draft sync`）；草稿还有未解决的冲突；知识库作业中 | 

 
POST`/api/kb/merge-requests/{number}/close`
 
关闭；关联批注退回 pending，草稿回到 open。

 
权限 知识库创建者、owner / admin 或作者

 
请求体

```
{
  "reason": "去重的例子和失败处理对不上"                                   // 选填，显示在作业页横幅（9.14）
}
```

 
响应 200

```
{
  "id": "e7f8a9b0-c1d2-4e3f-9a8b-7c6d5e4f3a2b",               // 变更请求 id（UUID）
  "number": 16,                                               // 工作区内编号，界面上的 #16
  "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 改动的知识库（一个变更请求只改一个知识库）
  "title": "去重键改为渠道交易号，补回调人工处理",                              // 标题
  "summary": "处理批注 a1b2c3d4：去重键改为渠道交易号，引用 MAR-142；新增「回调人工处理」。",  // 智能体的变更说明（含处理了哪些批注）
  "source": "annotations",                                    // 来源：ingest 收录资料 / health 健康检查 / merge 知识合并 / annotations 处理批注 / new_page 新页面 / revert 回滚 / custom 其他
  "status": "closed",                                         // open / merged / closed
  "risk": "medium",                                           // low / medium / high
  "author_type": "agent",                                     // agent / member
  "author_id": "3a9e2b10-77c4-4d1f-9b2e-6f5d4c3b2a19",        // 作者 id
  "author_name": "通用开发助手",                                    // 作者显示名
  "draft_id": "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",         // 变更请求指向的草稿；评论后智能体继续改这份草稿，diff 随之刷新
  "draft_version": 9,                                         // 草稿版本，每次写入 +1；合并时带上，防止合并审核人没看过的改动
  "annotation_ids": [                                         // 本次处理的批注
    "a1b2c3d4-0000-4000-8000-000000000001"
  ],
  "origin": {                                                 // 来源追溯：变更请求是从哪里发起的；判定顺序见 7.13 建变更请求接口
    "type": "kb_job",                                         // kb_job 知识库作业 / revert 回滚 / chat 对话 / autopilot_run 自动化运行 / issue 任务 / none 无来源，只显示作者
    "label": "知识库作业 · 处理批注",                                  // 来源的显示文字
    "ref_id": "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f"          // 来源对象 id，用于跳转
  },
  "job_id": "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f",           // 关联的知识库作业（无则 null）
  "reverts": null,                                            // 回滚的变更请求编号（不是回滚为 null）
  "merged_by": null,                                          // 合并人（未合并为 null）
  "merged_at": null,                                          // 合并时间（未合并为 null）
  "closed_by": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",        // 关闭人（未关闭为 null）
  "closed_at": "2026-10-25T11:05:00Z",                        // 关闭时间（未关闭为 null）
  "close_reason": "去重的例子和失败处理对不上",                            // 关闭理由（未关闭为空串）
  "created_at": "2026-10-25T10:31:00Z",                       // RFC3339
  "updated_at": "2026-10-25T10:41:00Z"                        // RFC3339
}
```

 
| 状态码 | 情况 | 
| 409 | 不是 open | 

 

#### 7.10 知识库作业

设计稿 · 9.1 列表 · 9.2 新建对话 · 9.3–9.6 作业到提交 · 9.7 定时收录 · 9.8 批注带入 · 9.9–9.16 边界情况

- 一个作业 = 一个现有聊天会话 + 一行 `kb_job`，草稿由智能体用 `kb draft create --job` 建，建草稿时同时写进 `kb_job_draft` 关联到作业；一个作业只关联一份草稿，一份草稿只属于一个作业（决策 34、104）。左侧整块复用聊天消息列表和输入框（`packages/views/chat/components/chat-message-list.tsx:181`、`chat-input.tsx:152`），发送 / 停止 / 排队发送沿用同一个按钮位（`chat-input.tsx:828`，决策 47）。
- 执行智能体由用户选，选择器复用自动化的执行者选择器，没有运行时的置灰（决策 39、28）。
- 首条消息由服务端拼：通用部分（8.4，带作业 id）+ 开场白附加段（8.5）+ 用户输入。之后的消息原样转发。
- 智能体建草稿之前，右侧是空状态，提交审核不可用；建好之后，右侧显示这份草稿，提交、放弃都作用于它（设计稿 9.17）。
- 右侧草稿随写入刷新（`kb.draft.updated` 1 秒内合并发送），diff 与检查复用变更请求详情的计算（决策 43）。
- 提交：用草稿建变更请求；智能体自己执行了 `kb mr create` 也算已提交，右侧自动转只读（决策 44）。
- 定时收录 / 健康检查：开场白引导智能体用现有 `marvis autopilot create`（`server/cmd/marvis/cmd_autopilot.go:38`）建普通自动化（8.5 schedule）。

```
sequenceDiagram
  participant U as 用户
  participant API as KB API
  participant CHAT as 聊天服务
  participant AG as 执行智能体
  U->>API: POST /bases/team/jobs（智能体、开场白、首条消息）
  API->>CHAT: 建会话，发首条消息（8.4 + 8.5 模板，带作业 id）
  CHAT->>AG: 派任务（任务令牌）
  AG->>API: kb draft create --job（建草稿并关联作业）
  API-->>U: kb.job.updated → 右侧显示这份草稿
  AG->>API: kb get / page fetch / page patch --draft
  API-->>U: kb.draft.updated → 右侧刷新改动与检查
  U->>CHAT: 继续对话（与现有聊天一致，可排队、可停止）
  U->>API: POST /jobs/{id}/submit
  API->>API: 用草稿建变更请求 #16
  API-->>U: kb.mr.created → 右侧只读「去审核 #16」
```

图 6 · 一个作业从新建到提交
| 开场白（starter） | 默认名称 | 附加提示词 | 变更请求来源 | 
| ingest | 收录资料 | 8.5 ingest | ingest | 
| health | 健康检查 | 8.5 health | health | 
| merge | 知识合并 | 8.5 merge | merge | 
| annotations | 处理批注 | 8.5 annotations | annotations | 
| new_page | 新页面 | 8.5 new_page | new_page | 
| schedule | 创建定时收录 / 健康检查 | 8.5 schedule | —（不改页面） | 
| custom | 取首条消息前 20 字 | 无 | custom | 

GET`/api/kb/bases/{kb}/jobs`
 
作业列表（聊天列表样式）。

 
权限 工作区成员；只返回自己发起的

 
| 参数 | 位置 | 类型 | 必填 | 说明 / 示例 | 
| `state` | query | string | 否 | `running` / `failed`；不传为全部 | 

 
响应 200

```
[
  {
    "id": "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f",             // 作业 id（UUID）
    "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 知识库 id
    "name": "处理批注",                                           // 作业名称，列表第一列
    "starter": "annotations",                                 // 开场白类型，决定默认名称、附加提示词和变更请求来源；自由描述为 custom
    "agent_id": "3a9e2b10-77c4-4d1f-9b2e-6f5d4c3b2a19",       // 执行智能体（工作区普通智能体）
    "agent_name": "通用开发助手",                                   // 执行智能体名称
    "chat_session_id": "d1e2f3a4-5b6c-4d7e-8f9a-0b1c2d3e4f5a",  // 这个作业的对话（现有聊天会话）
    "draft_id": "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",       // 这个作业关联的草稿，取自 kb_job_draft；智能体还没建草稿时为 null
    "created_by": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",     // 发起人
    "state": "idle",                                          // running 运行中 / idle 等待输入 / failed 失败 / stopped 已停止，取自对话最近一次任务
    "last_reply": "按王芳的批注改好了「支付回调」的去重一节，右边是草稿。",              // 智能体最后一条回复的片段，列表第二行
    "draft": {                                                // 草稿概况；还没有草稿时为 null
      "version": 9,                                           // 草稿版本，每次写入 +1
      "pages": 2,                                             // 改动页面数
      "added": 3,                                             // 新增行数
      "deleted": 1                                            // 删除行数
    },
    "merge_request": null,                                    // 这个作业的变更请求（没有为 null）
    "created_at": "2026-10-25T10:20:00Z",                     // RFC3339
    "updated_at": "2026-10-25T10:29:00Z"                      // RFC3339
  }
]
```

 
POST`/api/kb/bases/{kb}/jobs`
 
新建一个作业：建聊天会话、发首条消息。不建草稿，智能体建草稿时传作业 id 关联。

 
权限 工作区成员，且有该智能体的使用权限

 
请求体

```
{
  "agent_id": "3a9e2b10-77c4-4d1f-9b2e-6f5d4c3b2a19",         // 必填，执行智能体
  "starter": "annotations",                                   // 必填，开场白类型
  "name": "处理批注",                                             // 选填，不传按开场白取默认名
  "message": "处理团队知识库的全部 4 条待处理批注。",                          // 必填，用户的首条消息
  "annotation_ids": [                                         // 选填，处理批注时带上
    "a1b2c3d4-0000-4000-8000-000000000001"
  ],
  "page_id": null,                                            // 选填，「让智能体检查本页」「＋ 新页面」时带上所在页面
  "sources": []                                               // 选填，收录资料时指定的资料 uri（任务、对话、原始资料；原始资料标签页「交给智能体收录」带入）
}
```

 
响应 201

```
{
  "id": "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f",               // 作业 id（UUID）
  "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 知识库 id
  "name": "处理批注",                                             // 作业名称，列表第一列
  "starter": "annotations",                                   // 开场白类型，决定默认名称、附加提示词和变更请求来源；自由描述为 custom
  "agent_id": "3a9e2b10-77c4-4d1f-9b2e-6f5d4c3b2a19",         // 执行智能体（工作区普通智能体）
  "agent_name": "通用开发助手",                                     // 执行智能体名称
  "chat_session_id": "d1e2f3a4-5b6c-4d7e-8f9a-0b1c2d3e4f5a",  // 这个作业的对话（现有聊天会话）
  "draft_id": null,                                           // 这个作业关联的草稿，取自 kb_job_draft；智能体还没建草稿时为 null
  "created_by": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",       // 发起人
  "state": "running",                                         // running 运行中 / idle 等待输入 / failed 失败 / stopped 已停止，取自对话最近一次任务
  "last_reply": "",                                           // 智能体最后一条回复的片段，列表第二行
  "draft": null,                                              // 草稿概况；还没有草稿时为 null
  "merge_request": null,                                      // 这个作业的变更请求（没有为 null）
  "created_at": "2026-10-25T10:20:00Z",                       // RFC3339
  "updated_at": "2026-10-25T10:29:00Z"                        // RFC3339
}
```

 
| 状态码 | 情况 | 
| 403 | 没有该智能体的使用权限 | 
| 422 | 智能体没有绑定运行时 | 

 
GET`/api/kb/jobs/{id}`
 
作业详情：右侧草稿改动。还没关联草稿时 `draft_id`、`draft` 为 null，`pages`、`checks` 为空。

 
权限 作业发起人

 
响应 200

```
{
  "id": "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f",               // 作业 id（UUID）
  "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 知识库 id
  "name": "处理批注",                                             // 作业名称，列表第一列
  "starter": "annotations",                                   // 开场白类型，决定默认名称、附加提示词和变更请求来源；自由描述为 custom
  "agent_id": "3a9e2b10-77c4-4d1f-9b2e-6f5d4c3b2a19",         // 执行智能体（工作区普通智能体）
  "agent_name": "通用开发助手",                                     // 执行智能体名称
  "chat_session_id": "d1e2f3a4-5b6c-4d7e-8f9a-0b1c2d3e4f5a",  // 这个作业的对话（现有聊天会话）
  "draft_id": "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",         // 这个作业关联的草稿，取自 kb_job_draft；智能体还没建草稿时为 null
  "created_by": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",       // 发起人
  "state": "idle",                                            // running 运行中 / idle 等待输入 / failed 失败 / stopped 已停止，取自对话最近一次任务
  "last_reply": "按王芳的批注改好了「支付回调」的去重一节，右边是草稿。",                // 智能体最后一条回复的片段，列表第二行
  "draft": {                                                  // 草稿概况；还没有草稿时为 null
    "version": 9,                                             // 草稿版本，每次写入 +1
    "pages": 2,                                               // 改动的页面（GitLab MR 式文件卡片，每页一张）
    "added": 3,                                               // 新增行数
    "deleted": 1                                              // 删除行数
  },
  "merge_request": null,                                      // 这个作业的变更请求（没有为 null）
  "created_at": "2026-10-25T10:20:00Z",                       // RFC3339
  "updated_at": "2026-10-25T10:29:00Z",                       // RFC3339
  "pages": [                                                  // 改动的页面（GitLab MR 式文件卡片，每页一张）
    {
      "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",      // 页面 id（新建页面为草稿里分配的 id）
      "path": "/payment/callback",                            // 当前路径
      "old_path": "",                                         // 移动前路径（没移动为空串）
      "title": "支付回调",                                        // 页面标题
      "change": "modified",                                   // added / modified / moved / deleted
      "added": 2,                                             // 新增行数
      "deleted": 1,                                           // 删除行数
      "lines": [                                              // diff 行（块渲染成 Markdown 后逐行比较）
        {
          "kind": "context",                                  // context / add / delete
          "text": "## 去重",                                    // 行内容
          "block_id": "b7Kq",                                 // 行所在的块；「加入评论」带上它
          "old_line": 14,                                     // 基准版本行号（新增行为 0）
          "new_line": 14                                      // 草稿行号（删除行为 0）
        },
        {
          "kind": "delete",                                   // context / add / delete
          "text": "渠道回调按订单号加幂等键去重。[^mar-98]",                 // 行内容
          "block_id": "b8Xz",                                 // 行所在的块；「加入评论」带上它
          "old_line": 15,                                     // 基准版本行号（新增行为 0）
          "new_line": 0                                       // 草稿行号（删除行为 0）
        },
        {
          "kind": "add",                                      // context / add / delete
          "text": "渠道回调按渠道交易号加幂等键去重。[^mar-142]",              // 行内容
          "block_id": "b8Xz",                                 // 行所在的块；「加入评论」带上它
          "old_line": 0,                                      // 基准版本行号（新增行为 0）
          "new_line": 15                                      // 草稿行号（删除行为 0）
        },
        {
          "kind": "add",                                      // context / add / delete
          "text": "自 10 月 20 日起生效。[^mar-142]",                // 行内容
          "block_id": "bR2m",                                 // 行所在的块；「加入评论」带上它
          "old_line": 0,                                      // 基准版本行号（新增行为 0）
          "new_line": 16                                      // 草稿行号（删除行为 0）
        }
      ]
    },
    {
      "page_id": "33445566-7788-499a-8bbc-cddeeff00112",      // 页面 id（新建页面为草稿里分配的 id）
      "path": "/payment/callback-manual",                     // 当前路径
      "old_path": "",                                         // 移动前路径（没移动为空串）
      "title": "回调人工处理",                                      // 页面标题
      "change": "added",                                      // added / modified / moved / deleted
      "added": 1,                                             // 新增行数
      "deleted": 0,                                           // 删除行数
      "lines": [                                              // diff 行（块渲染成 Markdown 后逐行比较）
        {
          "kind": "add",                                      // context / add / delete
          "text": "# 回调人工处理",                                 // 行内容
          "block_id": "bA01",                                 // 行所在的块；「加入评论」带上它
          "old_line": 0,                                      // 基准版本行号（新增行为 0）
          "new_line": 1                                       // 草稿行号（删除行为 0）
        }
      ]
    }
  ],
  "checks": {                                                 // 提交前检查
    "lint": [                                                 // 格式检查（只看改动的页面）
      {
        "code": "orphan_page",                                // 规则编号
        "severity": "warning",                                // error / warning
        "page_id": "33445566-7788-499a-8bbc-cddeeff00112",    // 页面 id（新建页面为草稿里分配的 id）
        "path": "/payment/callback-manual",                   // 当前路径
        "message": "没有其他页面链接到这一页"                             // 说明
      }
    ],
    "conflicts": [                                            // 与主线冲突的块
      {
        "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",    // 页面 id（新建页面为草稿里分配的 id）
        "path": "/payment/callback",                          // 当前路径
        "block_id": "b8Xz",                                   // 行所在的块；「加入评论」带上它
        "main_lines": "15-15",                                // 主线上冲突的行范围
        "draft_lines": "15-16"                                // 草稿里冲突的行范围
      }
    ]
  }
}
```

 
POST`/api/kb/jobs/{id}/submit`
 
提交审核：用关联的草稿建变更请求，带入的批注 → processing。

 
权限 作业发起人

 
请求体

```
{
  "title": "去重键改为渠道交易号，补回调人工处理",                              // 选填，不传取智能体最后一轮总结的第一行
  "summary": ""                                               // 选填，不传取智能体最后一轮总结
}
```

 
响应 201

```
{
  "id": "e7f8a9b0-c1d2-4e3f-9a8b-7c6d5e4f3a2b",               // 变更请求 id（UUID）
  "number": 16,                                               // 工作区内编号，界面上的 #16
  "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 改动的知识库（一个变更请求只改一个知识库）
  "title": "去重键改为渠道交易号，补回调人工处理",                              // 标题
  "summary": "处理批注 a1b2c3d4：去重键改为渠道交易号，引用 MAR-142；新增「回调人工处理」。",  // 智能体的变更说明（含处理了哪些批注）
  "source": "annotations",                                    // 来源：ingest 收录资料 / health 健康检查 / merge 知识合并 / annotations 处理批注 / new_page 新页面 / revert 回滚 / custom 其他
  "status": "open",                                           // open / merged / closed
  "risk": "medium",                                           // low / medium / high
  "author_type": "agent",                                     // agent / member
  "author_id": "3a9e2b10-77c4-4d1f-9b2e-6f5d4c3b2a19",        // 作者 id
  "author_name": "通用开发助手",                                    // 作者显示名
  "draft_id": "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",         // 变更请求指向的草稿；评论后智能体继续改这份草稿，diff 随之刷新
  "draft_version": 9,                                         // 草稿版本，每次写入 +1；合并时带上，防止合并审核人没看过的改动
  "annotation_ids": [                                         // 本次处理的批注
    "a1b2c3d4-0000-4000-8000-000000000001"
  ],
  "origin": {                                                 // 来源追溯：变更请求是从哪里发起的；判定顺序见 7.13 建变更请求接口
    "type": "kb_job",                                         // kb_job 知识库作业 / revert 回滚 / chat 对话 / autopilot_run 自动化运行 / issue 任务 / none 无来源，只显示作者
    "label": "知识库作业 · 处理批注",                                  // 来源的显示文字
    "ref_id": "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f"          // 来源对象 id，用于跳转
  },
  "job_id": "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f",           // 关联的知识库作业（无则 null）
  "reverts": null,                                            // 回滚的变更请求编号（不是回滚为 null）
  "merged_by": null,                                          // 合并人（未合并为 null）
  "merged_at": null,                                          // 合并时间（未合并为 null）
  "closed_by": null,                                          // 关闭人（未关闭为 null）
  "closed_at": null,                                          // 关闭时间（未关闭为 null）
  "close_reason": "",                                         // 关闭理由（未关闭为空串）
  "created_at": "2026-10-25T10:31:00Z",                       // RFC3339
  "updated_at": "2026-10-25T10:41:00Z"                        // RFC3339
}
```

 
| 状态码 | 情况 | 
| 409 | 还没关联草稿；这一轮还在运行；检查有 error；草稿没有改动；已有打开的变更请求 | 

 
POST`/api/kb/jobs/{id}/discard`
 
放弃关联的草稿；作业保留在列表里，结果显示「已放弃」。

 
权限 作业发起人

 
响应 200

```
{
  "id": "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f",               // 作业 id（UUID）
  "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 知识库 id
  "name": "处理批注",                                             // 作业名称，列表第一列
  "starter": "annotations",                                   // 开场白类型，决定默认名称、附加提示词和变更请求来源；自由描述为 custom
  "agent_id": "3a9e2b10-77c4-4d1f-9b2e-6f5d4c3b2a19",         // 执行智能体（工作区普通智能体）
  "agent_name": "通用开发助手",                                     // 执行智能体名称
  "chat_session_id": "d1e2f3a4-5b6c-4d7e-8f9a-0b1c2d3e4f5a",  // 这个作业的对话（现有聊天会话）
  "draft_id": "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",         // 这个作业关联的草稿，取自 kb_job_draft；智能体还没建草稿时为 null
  "created_by": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",       // 发起人
  "state": "idle",                                            // running 运行中 / idle 等待输入 / failed 失败 / stopped 已停止，取自对话最近一次任务
  "last_reply": "按王芳的批注改好了「支付回调」的去重一节，右边是草稿。",                // 智能体最后一条回复的片段，列表第二行
  "draft": {                                                  // 草稿概况；还没有草稿时为 null
    "version": 9,                                             // 草稿版本，每次写入 +1
    "pages": 0,                                               // 改动页面数
    "added": 0,                                               // 新增行数
    "deleted": 0                                              // 删除行数
  },
  "merge_request": null,                                      // 这个作业的变更请求（没有为 null）
  "created_at": "2026-10-25T10:20:00Z",                       // RFC3339
  "updated_at": "2026-10-25T10:29:00Z"                        // RFC3339
}
```

 
| 状态码 | 情况 | 
| 409 | 还没关联草稿；已提交审核 | 

 
| 边界情况（设计稿） | 服务端判断 | 界面 | 
| 还没关联草稿（9.17） | `kb_job_draft` 里没有这个作业 | 右侧空状态，提交审核不可用 | 
| 这一轮还在运行（9.11） | 对话最近任务未结束 | 提交按钮不可用；输入框按钮变「停止」 | 
| 智能体自己提交（9.10） | 草稿有 open 变更请求 | 右侧只读，「去审核 #16」 | 
| 检查有 error（9.9） | `checks.lint` 含 error | 不可提交，「让智能体修复」 | 
| 与主线冲突（9.12） | `checks.conflicts` 非空 | 可以提交；「让智能体基于主线更新」 | 
| 没有改动（9.13） | 草稿没有页面 | 不显示提交 / 放弃，记为「无需修改」 | 
| 变更请求被关闭（9.14） | 变更请求 closed | 草稿回到 open，可重新提交（新开变更请求） | 
| 已合并（9.15） | 变更请求 merged | 只读，对话结束 | 

#### 7.11 配置知识库

设计稿 · 10.1 开场引导 · 10.2 对话中 · 10.3 直接修改 · 10.4 保存 · 10.5 放大编辑

- 与创建同一套构建器（决策 39）：`mode = config`。
- 右侧两个 Markdown 编辑框「目标」「Schema」，可放大成左编辑右预览的弹窗（决策 41）；默认 Schema 模式下 Schema 只读。
- 只有「保存」（决策 51）：直接更新 `kb_base`，同一事务写一行 `kb_config_revision`，立即生效，不走变更请求（决策 4）。

PATCH`/api/kb/bases/{kb}`
 
更新知识库。

 
权限 知识库创建者或 owner / admin

 
请求体

```
{
  "name": "团队知识库",                                            // 选填
  "description": "订单、支付、发布与测试流程。",                            // 选填
  "purpose": "# 目标\n\n## 读者\n研发和测试……\n",                      // 选填，目标全文
  "schema_mode": "custom",                                    // 选填，不传保持原值；切到 default 等于把 Schema 换回当前内置模板
  "schema": "# Schema\n\nThis file tells agents……\n",         // 只有生效的模式是 custom 时才能带，Schema 全文；default 时不能带
  "base_updated_at": "2026-10-25T14:20:11Z"                   // 打开配置时的 updated_at，防止覆盖别人的修改
}
```

 
响应 200

```
{
  "id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",               // 知识库 id（UUID）
  "workspace_id": "ws_8f2a1c",                                // 工作区 id
  "name": "团队知识库",                                            // 名称
  "slug": "team",                                             // 工作区内唯一，小写字母 / 数字 / 连字符；页面引用写 slug:/路径
  "description": "订单、支付、发布与测试流程，团队共用的业务和系统知识。",               // 简介；智能体据此判断要不要用这个知识库
  "schema_mode": "default",                                   // default 内置模板（只读）/ custom 自定义
  "created_by": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",       // 创建人
  "page_count": 42,                                           // 页面数
  "content_version": 87,                                      // 内容版本，每次合并 +1；ETag 和检索索引以它为准
  "created_at": "2026-10-08T09:12:03Z",                       // RFC3339
  "updated_at": "2026-10-25T14:20:11Z",                       // RFC3339
  "mention": "[团队知识库](mention://kb/5b1f0c2e…)"                // 原样贴进回复，渲染成卡片（7.14）；示例里的 id 截短了
}
```

 
| 状态码 | 情况 | 
| 400 | `default` 时带了 `schema`；切到 `custom` 却没带 `schema` | 
| 403 | 不是知识库创建者或 owner / admin | 
| 409 | 打开配置后被别人保存过 | 

 

#### 7.12 知识库管理与导出

设计稿 · 11.1 原始资料 · 11.2 导出 · 11.3 删除

- 原始资料：上传到对象存储，写 `kb_raw`，立即可用；工作区成员都能上传（决策 101）；「交给智能体收录」新建一次 `starter = ingest` 的作业，带上选中的文件。页面里用到的图片同样上传，`kind = asset`。列表里每一行点开就是附件预览（同阅读页）。
- 可见范围：「原始资料」「导出」两个标签页成员都能看到，「删除知识库」只对知识库创建者和 owner / admin 显示。
- 删除：知识库创建者或 owner / admin，输入知识库名称确认；同一事务删除 `kb_*` 关联行、关闭打开的变更请求；对象存储里的文件由后台任务清理。

导出 OKF bundle（决策 57）

```
team.zip
└── team/                         用 Obsidian 打开这个目录作为库
    ├── PURPOSE.md                bundle 外：不是概念页
    ├── SCHEMA.md
    ├── raw/
    │   ├── sources/channel-v3.pdf
    │   └── assets/callback-flow.png
    └── wiki/                     OKF bundle
        ├── index.md              生成（根目录可带 okf_version: 0.2）
        ├── quickstart.md
        ├── workflows/
        │   ├── index.md          生成，只列 workflows 的子页面
        │   ├── payment-callback.md
        │   └── refund.md
        ├── concepts/
        │   ├── index.md
        │   └── idempotency.md
        └── .claims/              OpenWiki 惯例，每页一份论断
            └── workflows/payment-callback.json
```

| 项 | 导出规则 | 依据 | 
| 页面文件 | 每页 `<slug>.md`；有子页面的再建同名目录 | OKF §3：路径即身份 | 
| 页头 | JSON 转 YAML；加 `marvis_id: <页面 id>` 便于导回 | OKF §11：消费方必须接受未知键 | 
| 链接 | `kb://` 改写为相对路径并对空格等字符 URL 编码；目标是标题块时写 `#标题文字`，其他块写 `#^块id` 并在目标块末尾加 ` ^块id` | OKF §6.1 允许相对路径；Obsidian 文档：标题链接用 `#标题`、块链接用 `#^id`、Markdown 链接需 URL 编码 | 
| 还没写的页面 | 链接保留为指向不存在文件的相对路径 | OKF §6.1：必须容忍断链 | 
| 原始资料 | 导出到 `raw/sources/`、`raw/assets/`；`raw://` 改写为相对路径（如 `../raw/sources/channel-v3.pdf`） | Obsidian 按相对路径打开文件、显示图片 | 
| index | 每个目录生成 index.md | OKF §8 | 
| 论断 | `.claims/<路径>.json` | OpenWiki 惯例；不是 .md，不影响 OKF 一致性 | 

Obsidian：打开 `team/` 目录即可浏览，页面链接、块链接、图片、脚注都能用。限制：Obsidian 属性面板不支持嵌套属性，`sources`、`verified` 这类对象列表要切到源码模式查看（Obsidian 帮助文档 Properties 页）。

POST`/api/kb/bases/{kb}/raw`
 
上传原始资料（multipart，字段 `file`，可多个；`kind` 默认 source）。

 
权限 工作区成员

 
响应 201

```
{
  "files": [                                                  // 写入的文件
    {
      "id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f7a",           // 资料 id
      "kind": "source",                                       // source / asset
      "name": "channel-v3.pdf",                               // 文件名
      "uri": "raw://sources/channel-v3.pdf",                  // 页面里引用它的地址
      "size": 482113                                          // 字节数
    }
  ]
}
```

 
| 状态码 | 情况 | 
| 409 | 同名文件已存在 | 

 
GET`/api/kb/bases/{kb}/raw`
 
原始资料列表（原始资料标签页）。

 
权限 工作区成员

 
| 参数 | 位置 | 类型 | 必填 | 说明 / 示例 | 
| `kind` | query | string | 否 | `source` / `asset`；不传为全部 | 

 
响应 200

```
[
  {
    "id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f7a",             // 资料 id
    "kind": "source",                                         // 类型
    "name": "channel-v3.pdf",                                 // 文件名
    "uri": "raw://sources/channel-v3.pdf",                    // 引用地址
    "content_type": "application/pdf",                        // MIME 类型，决定预览方式
    "size": 482113,                                           // 字节数
    "uploaded_by_name": "王芳",                                 // 上传人
    "created_at": "2026-10-08T10:12:00Z",                     // 上传时间
    "cited_pages": 3                                          // 引用它的页面数（查论断证据）
  }
]
```

 
GET`/api/kb/raw/{id}/content`
 
取文件内容，供预览和下载：返回 302 到对象存储的短时签名地址（未配置对象存储时由服务端直接输出）；`?download=1` 时以附件下载。

 
权限 工作区成员

 
GET`/api/kb/bases/{kb}/export`
 
导出 OKF bundle（`Content-Disposition: attachment; filename="team.zip"`），流式生成。

 
权限 工作区成员

 
DELETE`/api/kb/bases/{kb}`
 
删除知识库。

 
权限 知识库创建者或 owner / admin

 
请求体

```
{
  "confirm_name": "团队知识库"                                     // 必须与知识库名称一致
}
```

 
响应 200

```
{
  "deleted": true,                                            // 已删除
  "closed_mrs": [                                             // 被一并关闭的变更请求编号
    16
  ]
}
```

 
| 状态码 | 情况 | 
| 400 | 名称不一致 | 
| 403 | 不是知识库创建者或 owner / admin | 

 

#### 7.13 智能体读写接口（CLI 背后）

人在界面上不改页面；这些接口只给 CLI 用（人用 CLI 也可以调用，权限照常，决策 46）。照飞书 CLI 的做法：先按范围读局部，再按块改，每次写入后用返回的新 version 继续。

GET`/api/kb/pages/{ref}/fetch`
 
按范围读页面。`{ref}` 是页面 id 或 `team:/payment/callback`。

 
权限 工作区成员；`draft` 要求能写这份草稿

 
| 参数 | 位置 | 类型 | 必填 | 说明 / 示例 | 
| `detail` | query | string | 否 | `simple`（默认）返回整段 Markdown（`content` 字段，不带块 id，用于阅读、总结）/ `with-ids` 返回带 id 的块数组（`blocks`，修改前用，`patch` 要靠块 id 定位） | 
| `scope` | query | string | 否 | 读哪一部分，默认 `full` 整页。页面长时只读需要的部分，省上下文：`outline` 只返回标题块（看结构、找要读的那一节）/ `section` 某个标题下的整节 / `keyword` 含关键词的块 / `range` 两个块之间的连续一段 / `full` 整页 | 
| `start_block_id` | query | string | 否 | `section`：标题块 id；`range`：起始块 id | 
| `end_block_id` | query | string | 否 | `range`：结束块 id（含），不传读到页尾 | 
| `keyword` | query | string | 否 | `keyword`：关键词，多个用 `|` 分隔 | 
| `context_before / context_after` | query | int | 否 | `keyword` / `section` / `range` 时在前 / 后多带几块，默认 0 | 
| `max_depth` | query | int | 否 | `outline`：只返回到第几级标题，默认全部 | 
| `revision_id` | query | string | 否 | 读某个历史修订，不传读当前版本；不能和 `draft` 同时带 | 
| `draft` | query | uuid | 否 | 草稿 id。带上后读这份草稿里改过的版本，草稿没改这页就读主线；改页面前读取要带上，拿到的 `version` 才对得上这份草稿 | 
| `backlinks` | query | bool | 否 | 同时返回反向链接 | 

 
响应 200

```
{
  "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",          // 页面 id
  "path": "/payment/callback",                                // 路径
  "title": "支付回调",                                            // 标题
  "version": "d9",                                            // 写入时带回（草稿页 d，主线页为修订 id）
  "frontmatter": {                                            // 页头（outline 也返回）
    "type": "Workflow",                                       // 类型
    "title": "支付回调",                                          // 标题
    "description": "渠道异步回调的接收、去重与失败处理"                        // 说明
  },
  "blocks": [                                                 // 本次范围内的块
    {
      "id": "b7Kq",                                           // 块 id
      "kind": "text",                                         // 块类型，目前只有 text（内容是一段 Markdown）
      "content": "## 去重"                                      // 块内容：一段 Markdown，链接已换成路径
    },
    {
      "id": "b8Xz",                                           // 块 id
      "kind": "text",                                         // 块类型，目前只有 text（内容是一段 Markdown）
      "content": "按渠道交易号去重。[^mar-142]"                        // 块内容：一段 Markdown，链接已换成路径
    },
    {
      "id": "b9Ln",                                           // 块 id
      "kind": "text",                                         // 块类型，目前只有 text（内容是一段 Markdown）
      "content": "见[幂等键](/payment/idempotency.md#^b9Lm)。"     // 块内容：一段 Markdown，链接已换成路径
    }
  ],
  "children": [                                               // 子页面
    {
      "path": "/payment/callback/retry",                      // 路径
      "title": "回调重试"                                         // 标题
    }
  ],
  "truncated": false                                          // 范围超出 200 块时截断（simple 按同样的块数截断）
}
```

 
POST`/api/kb/drafts`
 
建一份草稿；传 `job_id` 时关联到该作业。

 
权限 工作区成员（智能体按令牌绑定的人）；传 `job_id` 时须是作业发起人，或这个作业里执行的智能体（按任务令牌）

 
请求体

```
{
  "knowledge_base": "team",                                   // slug 或 id
  "title": "每日收录 · 10-25",                                    // 选填，草稿标题，说明这份草稿改了什么；和变更请求标题无关
  "job_id": "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f"            // 选填，作业 id；传了就在同一事务里写 kb_draft 和 kb_job_draft
}
```

 
响应 201

```
{
  "id": "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",               // 草稿 id
  "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 知识库
  "version": 0,                                               // 版本
  "status": "open"                                            // 状态
}
```

 
| 状态码 | 情况 | 
| 403 | 传了 `job_id`，调用方不是作业发起人，也不是这个作业里执行的智能体 | 
| 404 | 作业不存在，或不属于这个知识库 | 
| 409 | `job_draft_exists`：作业已有草稿，响应带已关联的 `draft_id` | 

 
任务令牌调用时，服务端把当前任务记进 `kb_draft.task_id`，成员调用时为空；记录草稿由哪次运行建的，用于审核页来源判定和排查溯源，不在响应里返回。传 `job_id` 建成后发 `kb.job.updated`。

 
POST`/api/kb/drafts/{id}/pages`
 
在草稿里新建页面。

 
权限 能写这份草稿

 
请求体

```
{
  "parent": "team:/payment",                                  // 父页面；顶层为 team:/
  "after": "team:/payment/callback",                          // 排在哪个兄弟之后；不传排最后
  "slug": "callback-manual",                                  // 路径段
  "frontmatter": {                                            // 页头，至少 type / title / description
    "type": "Workflow",                                       // 类型
    "title": "回调人工处理",                                        // 标题
    "description": "回调失败后如何人工补单"                              // 说明
  },
  "content": "# 回调人工处理\n\n……"                                 // 正文
}
```

 
响应 201

```
{
  "page_id": "33445566-7788-499a-8bbc-cddeeff00112",          // 新页面 id
  "path": "/payment/callback-manual",                         // 路径
  "version": "d10",                                           // 新版本
  "blocks": [                                                 // 分配的块 id
    "bA01",
    "bA02"
  ]
}
```

 
| 状态码 | 情况 | 
| 409 | 同级路径段重复 | 

 
POST`/api/kb/drafts/{id}/pages/{ref}/ops`
 
按块修改；也用于移动、删除页面。

 
权限 能写这份草稿

 
请求体

```
{
  "version": "d9",                                            // 必填，最近一次 fetch 的 version
  "ops": [                                                    // 按顺序执行，全部成功或全部失败
    {
      "op": "block_replace",                                  // block_replace / block_insert_after / block_delete / block_move_after / str_replace / append / set_meta / move / delete
      "block": "b8Xz",                                        // 目标块；block_insert_after 传 start 插到最前
      "content": "按渠道交易号加幂等键去重。[^mar-142]"                    // 新内容（Markdown），可含多块，服务端切块
    },
    {
      "op": "block_insert_after",                             // block_replace / block_insert_after / block_delete / block_move_after / str_replace / append / set_meta / move / delete
      "block": "b8Xz",                                        // 目标块；block_insert_after 传 start 插到最前
      "content": "自 10 月 20 日起生效。[^mar-142]"                  // 新内容（Markdown），可含多块，服务端切块
    },
    {
      "op": "set_meta",                                       // block_replace / block_insert_after / block_delete / block_move_after / str_replace / append / set_meta / move / delete
      "fields": {                                             // set_meta：要改的页头字段（不能改 sources、generated）
        "status": "stable",                                   // 生命周期
        "stale_after": "2027-01-20T00:00:00Z"                 // 复核期
      }
    }
  ]
}
```

 
响应 200

```
{
  "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",          // 页面
  "version": "d11",                                           // 新版本
  "new_blocks": [                                             // 新分配的块 id
    "bR2m"
  ],
  "warnings": [                                               // 这次写入涉及的检查结果
    {
      "code": "unresolved_link",                              // 规则
      "severity": "warning",                                  // 级别
      "message": "/payment/refund 还没写"                        // 说明
    }
  ]
}
```

 
| 状态码 | 情况 | 
| 404 | 块不存在 | 
| 409 | `stale_version`：页面在你读取后被改过；`str_replace` 匹配到 0 处或多处 | 

 
PUT`/api/kb/drafts/{id}/pages/{ref}/claims`
 
整页写入论断；服务端据此重算页头 sources。

 
权限 能写这份草稿

 
请求体

```
{
  "version": "d11",                                           // 必填
  "claims": [                                                 // 本页论断
    {
      "key": "c2",                                            // 页内编号
      "block_id": "b8Xz",                                     // 论断所在的块
      "text": "渠道回调按渠道交易号加幂等键去重。",                            // 陈述原文
      "evidence": [                                           // 支撑它的证据
        {
          "source": "mar-142",                                // 脚注 id，即页头 sources[].id
          "uri": "task://MAR-142",                            // 证据地址（不含版本）
          "title": "回调改用渠道交易号去重",                             // 脚注显示文字
          "version": "2026-10-20T08:00:00Z"                   // 必填
        }
      ],
      "checked_at": "2026-10-25T10:28:00Z"                    // 智能体核对的时间
    }
  ]
}
```

 
响应 200

```
{
  "version": "d12",                                           // 新版本
  "sources": [                                                // 重算后的页头 sources
    {
      "id": "mar-142",                                        // 脚注 id
      "resource": "task://MAR-142",                           // 证据地址
      "title": "回调改用渠道交易号去重"                                  // 显示文字
    }
  ]
}
```

 
GET`/api/kb/bases/{kb}/claims`
 
按证据查论断（健康检查用）。

 
权限 工作区成员

 
| 参数 | 位置 | 类型 | 必填 | 说明 / 示例 | 
| `evidence` | query | string | 否 | uri 前缀，如 `repo://pay-service/` | 
| `checked_before` | query | RFC3339 | 否 | 只看核实时间早于它的 | 

 
响应 200

```
[
  {
    "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",        // 页面
    "path": "/payment/callback",                              // 路径
    "key": "c1",                                              // 页内编号
    "block_id": "b2Fa",                                       // 论断所在的块
    "text": "支付服务接收各渠道的异步回调……",                               // 陈述原文
    "evidence": [                                             // 支撑它的证据
      {
        "source": "pay-cb",                                   // 脚注 id，即页头 sources[].id
        "uri": "repo://pay-service/callback/handler.go#L40-L82",  // 证据地址（不含版本）
        "title": "回调入口",                                      // 脚注显示文字
        "version": "4e5f6a7"                                  // 核对时的证据版本：代码为提交，任务 / 对话为最后更新时间
      }
    ],
    "checked_at": "2026-10-25T10:28:00Z"                      // 智能体核对的时间
  }
]
```

 
GET`/api/kb/drafts/{id}`
 
草稿改动与检查（作业详情右侧、`kb draft check` 都用它）。

 
权限 能写这份草稿

 
响应 200

```
{
  "id": "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",               // 草稿
  "version": 12,                                              // 版本
  "status": "open",                                           // 状态
  "pages": [                                                  // 改动的页面（GitLab MR 式文件卡片，每页一张）
    {
      "page_id": "33445566-7788-499a-8bbc-cddeeff00112",      // 页面 id（新建页面为草稿里分配的 id）
      "path": "/payment/callback-manual",                     // 当前路径
      "old_path": "",                                         // 移动前路径（没移动为空串）
      "title": "回调人工处理",                                      // 页面标题
      "change": "added",                                      // added / modified / moved / deleted
      "added": 1,                                             // 新增行数
      "deleted": 0,                                           // 删除行数
      "lines": [                                              // diff 行（块渲染成 Markdown 后逐行比较）
        {
          "kind": "add",                                      // context / add / delete
          "text": "# 回调人工处理",                                 // 行内容
          "block_id": "bA01",                                 // 行所在的块；「加入评论」带上它
          "old_line": 0,                                      // 基准版本行号（新增行为 0）
          "new_line": 1                                       // 草稿行号（删除行为 0）
        }
      ]
    }
  ],
  "checks": {                                                 // 提交前检查
    "lint": [                                                 // 格式检查（只看改动的页面）
      {
        "code": "orphan_page",                                // 规则编号
        "severity": "warning",                                // error / warning
        "page_id": "33445566-7788-499a-8bbc-cddeeff00112",    // 页面 id（新建页面为草稿里分配的 id）
        "path": "/payment/callback-manual",                   // 当前路径
        "message": "没有其他页面链接到这一页"                             // 说明
      }
    ],
    "conflicts": [                                            // 与主线冲突的块
      {
        "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",    // 页面 id（新建页面为草稿里分配的 id）
        "path": "/payment/callback",                          // 当前路径
        "block_id": "b8Xz",                                   // 行所在的块；「加入评论」带上它
        "main_lines": "15-15",                                // 主线上冲突的行范围
        "draft_lines": "15-16"                                // 草稿里冲突的行范围
      }
    ]
  }
}
```

 
POST`/api/kb/drafts/{id}/sync`
 
把主线的新改动合进草稿（`kb draft sync`，见 6.3 冲突解决）。

 
权限 能写这份草稿

 
响应 200

```
{
  "version": 13,                                              // 草稿新版本；之后的写入都基于它
  "pages": [                                                  // 主线动过的草稿页（主线没动的页不列）
    {
      "page_id": "22334455-6677-4889-9aab-bccddeeff001",      // 页面
      "path": "/payment/idempotency",                         // 路径
      "result": "merged",                                     // merged 自动合入 / conflict 有冲突
      "conflicts": []                                         // 这一页的冲突
    },
    {
      "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",      // 页面
      "path": "/payment/callback",                            // 路径
      "result": "conflict",                                   // merged 自动合入 / conflict 有冲突
      "conflicts": [                                          // 这一页的冲突
        {
          "kind": "block",                                    // block 块 / meta 页头键 / move 位置 / page 一边删页一边改页
          "block_id": "b8Xz"                                  // 冲突块；内容里已写入冲突标记
        }
      ]
    }
  ],
  "unresolved": 1                                             // 整份草稿还没解决的冲突数
}
```

 
| 状态码 | 情况 | 
| 409 | 草稿不是 open | 

 
POST`/api/kb/merge-requests`
 
用草稿建变更请求（作业里的提交走 7.10）。

 
权限 能写这份草稿

 
请求体

```
{
  "draft_id": "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",         // 草稿
  "title": "每日收录 · 10-25",                                    // 变更请求标题，描述这次合并
  "summary": "收录 MAR-150、MAR-151……",                          // 变更说明
  "risk": "medium",                                           // 风险
  "source": "ingest",                                         // 来源
  "annotation_ids": []                                        // 处理的批注
}
```

 
响应 201

```
{
  "id": "e7f8a9b0-c1d2-4e3f-9a8b-7c6d5e4f3a2b",               // 变更请求 id（UUID）
  "number": 17,                                               // 工作区内编号，界面上的 #16
  "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 改动的知识库（一个变更请求只改一个知识库）
  "title": "每日收录 · 10-25",                                    // 标题
  "summary": "处理批注 a1b2c3d4：去重键改为渠道交易号，引用 MAR-142；新增「回调人工处理」。",  // 智能体的变更说明（含处理了哪些批注）
  "source": "ingest",                                         // 来源：ingest 收录资料 / health 健康检查 / merge 知识合并 / annotations 处理批注 / new_page 新页面 / revert 回滚 / custom 其他
  "status": "open",                                           // open / merged / closed
  "risk": "medium",                                           // low / medium / high
  "author_type": "agent",                                     // agent / member
  "author_id": "3a9e2b10-77c4-4d1f-9b2e-6f5d4c3b2a19",        // 作者 id
  "author_name": "通用开发助手",                                    // 作者显示名
  "draft_id": "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",         // 变更请求指向的草稿；评论后智能体继续改这份草稿，diff 随之刷新
  "draft_version": 9,                                         // 草稿版本，每次写入 +1；合并时带上，防止合并审核人没看过的改动
  "annotation_ids": [],                                       // 本次处理的批注
  "origin": {                                                 // 来源追溯：变更请求是从哪里发起的；判定顺序见 7.13 建变更请求接口
    "type": "autopilot_run",                                  // kb_job 知识库作业 / revert 回滚 / chat 对话 / autopilot_run 自动化运行 / issue 任务 / none 无来源，只显示作者
    "label": "自动化 · 每日收录",                                    // 来源的显示文字
    "ref_id": "f0e1d2c3-b4a5-4968-8776-5a4b3c2d1e0f"          // 来源对象 id，用于跳转
  },
  "job_id": null,                                             // 关联的知识库作业（无则 null）
  "reverts": null,                                            // 回滚的变更请求编号（不是回滚为 null）
  "merged_by": null,                                          // 合并人（未合并为 null）
  "merged_at": null,                                          // 合并时间（未合并为 null）
  "closed_by": null,                                          // 关闭人（未关闭为 null）
  "closed_at": null,                                          // 关闭时间（未关闭为 null）
  "close_reason": "",                                         // 关闭理由（未关闭为空串）
  "created_at": "2026-10-25T10:31:00Z",                       // RFC3339
  "updated_at": "2026-10-25T10:41:00Z"                        // RFC3339
}
```

 
| 状态码 | 情况 | 
| 409 | 检查有 error；草稿没有改动；已有打开的变更请求 | 

 
审核页「来源」按下表顺序判定：

 
| 顺序 | 条件 | `origin.type` | 审核页「来源」跳到 | 
| 1 | 草稿在 `kb_job_draft` 里关联了作业（作业页「提交审核」，或作业里的智能体执行 `kb mr create`） | `kb_job` | 作业页 | 
| 2 | `reverts_id` 不为空 | `revert` | 被回滚的变更请求 | 
| 3 | 草稿的 `task_id` 不为空，反查任务表 | `chat` / `issue` / `autopilot_run` | 对话 / 任务 / 自动化运行 | 
| 4 | 以上都没有 | `none` | 不跳转，只显示作者 | 

GET`/api/kb/sources`
 
列出可收录的资料：任务、评论、对话、原始资料。

 
权限 工作区成员；对话只返回调用者按现有规则能看的（决策 33）

 
| 参数 | 位置 | 类型 | 必填 | 说明 / 示例 | 
| `kb` | query | string | 是 | 知识库 | 
| `since` | query | RFC3339 | 否 | 只看这之后更新的 | 
| `kinds` | query | string | 否 | `task,comment,chat,raw` | 
| `ingested` | query | bool | 否 | 默认 false：只列还没收录的 | 

 
响应 200

```
[
  {
    "uri": "task://MAR-150",                                  // 资料地址
    "kind": "task",                                           // 类型
    "title": "退款回调重复入账",                                      // 标题（对话为「对话」）
    "updated_at": "2026-10-24T16:10:00Z",                     // 最后更新
    "ingested": false                                         // 已有论断的证据引用了它（查 kb_claim.evidence 的 GIN 索引）
  }
]
```

 

#### 7.14 对话里的知识库卡片

设计稿 · 12.1 知识库卡片 · 12.2 变更请求卡片 · 12.3 页面卡片（可带块）· 12.4 批注卡片 · 9.10

照现有任务卡片做：智能体在回复里写 `mention://` 链接，前端统一渲染器把它换成卡片，悬停出详情，点击跳转。和任务、项目链接一样只是链接，不通知人、不启动智能体（决策 62）。

| 现有实现 | 位置（`9a7f600b6`） | 知识库怎么接 | 
| 统一渲染器按链接类型出卡片 | `packages/views/rich-content/rich-content.tsx:271-290`（`mention://(member|agent|issue|project|all)`） | 正则加 `kb`、`kb_page`、`kb_mr`、`kb_annotation`，各接一个卡片组件 | 
| 任务卡片 + 悬停详情 | `packages/views/issues/components/issue-mention-card.tsx:57`（`IssueChip` + `IssueHoverCard` + `AppLink`） | 照写 `KbMentionCard`、`KbPageMentionCard`、`KbChangeMentionCard`、`KbAnnotationMentionCard`，放 `packages/views/kb/components/` | 
| 编辑器里的卡片 | `packages/views/editor/extensions/mention-view.tsx:30-55` | 同样按类型分支，评论、任务描述里贴的知识库链接也显示成卡片 | 
| 站内链接自动展开成卡片 | `rich-content.tsx:197` `unfurlableEntityLink` → `packages/views/editor/utils/link-handler.ts:179` `parseWorkspaceEntityLink` | 加知识库路由：`/{slug}/kb/{kb}`、`/{slug}/kb/{kb}/pages/{id}`、`/{slug}/kb/merge-requests/{id}`；页面链接允许带块的 `#` | 
| 通用 Markdown 的兜底 | `packages/ui/markdown/Markdown.tsx:155` | 正则同步加类型（终端等无卡片场景显示为文字） | 
| 服务端提及解析（通知、触发智能体） | `server/internal/util/mention.go:16` `MentionRe` 只认 member / agent / squad / issue / all | 不改：知识库链接不进通知和触发；加测试断言 `mention://kb_*` 不被解析 | 
| 智能体写链接的说明 | `runtime_config_sections.go:764` `writeMentions`，只在任务里出现（`:981`） | 写进 8.2 的「Knowledge Bases」一节（任务、聊天、自动化都有） | 

| 类型 | 链接 | 卡片 | 悬停详情 | 点击 | 解析接口 | 
| 知识库 | `[支付排障手册](mention://kb/<kb id>)` | 书本图标 + 名称 | slug、简介、页面数、Schema 模式、创建人 | 知识库首页 | `GET /api/kb/bases/{id}` | 
| 变更请求 | `[#16 去重键…](mention://kb_mr/<id>)` | 分支图标 + #16 + 标题 | 状态（待审核 / 已合并 / 已关闭，实时）、说明、知识库、页面数和行数、风险、作者、来源 | 审核页 | `GET /api/kb/merge-requests/{id}`（7.9，接受编号或 id） | 
| 页面 | `[支付回调](mention://kb_page/<page id>)`，带块 `…/<page id>#b8Xz` | 页面图标 + 标题，带块时加「› 小节标题」 | 路径、type、那一块的原文、论断数、待处理批注、复核期、最近修改 | 阅读页并滚到该块高亮 | `GET /api/kb/pages/{id}`（7.4） | 
| 批注 | `[批注 · 支付回调](mention://kb_annotation/<id>)` | 批注图标 + 页面 + 摘要 | 状态、原句、批注内容、作者、来源 | 页面并定位到原句 | 🆕 `GET /api/kb/annotations/{id}` | 

- 智能体不用自己拼链接：CLI 写操作和 `fetch` / `search` 的 JSON 输出都带 `mention` 字段（如 `kb create`、`kb mr create`、`kb annotation add`、`kb page fetch`、`kb search` 的每个命中），回复时原样贴。8.2 一节里写明这一点。
- 解析失败（已删除、没有权限、不是当前工作区）时卡片退回普通文字，和任务卡片一致；页面已删除显示「页面已删除」。
- 卡片数据走 TanStack Query 按 id 缓存，WebSocket 事件（第 9 章）让对应查询失效，所以变更请求合并后卡片状态自动变成「已合并」。
- 作业页对话（9.10）里智能体自己提交的变更请求也用同一张卡片，不再单独画块状卡片。

```
sequenceDiagram
  participant AG as 智能体
  participant CLI as marvis kb
  participant API as KB API
  participant FE as 对话（RichContent）
  AG->>CLI: kb mr create --draft … --output json
  CLI->>API: POST /api/kb/merge-requests
  API-->>CLI: 变更请求 + mention 字段
  CLI-->>AG: "mention": "[#16 去重键…](mention://kb_mr/<id>)"
  AG-->>FE: 回复里原样写这个链接
  FE->>FE: 识别 mention://kb_mr → 变更请求卡片
  FE->>API: 悬停时 GET /api/kb/merge-requests/{id}（Query 缓存）
```

图 7 · 智能体提交变更请求后，回复里的链接变成卡片
GET`/api/kb/annotations/{id}`
 
读一条批注（卡片悬停用）。

 
权限 工作区成员

 
响应 200

```
{
  "id": "a1b2c3d4-0000-4000-8000-000000000001",               // 批注 id
  "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 知识库 id
  "page_id": "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",          // 挂在哪一页；null 表示挂在整个知识库
  "page_path": "/payment/callback",                           // 页面当前路径（知识库级为空串）
  "page_title": "支付回调",                                       // 页面标题（知识库级为空串）
  "block_id": "b8Xz",                                         // 原句所在的块（整页 / 整库为空串）
  "quote": "渠道回调按订单号加幂等键去重。",                                 // 挂在某一句时为原句，整页 / 整库为空串
  "prefix": "## 去重\n",                                        // 原句前 32 字，用于改写后重新定位
  "suffix": "幂等键在 Redis 中保存 24 小时",                           // 原句后 32 字
  "body": "去重键已经改成渠道交易号，不是订单号。",                              // 批注内容
  "author_type": "member",                                    // member / agent
  "author_id": "7c6b5a49-3827-4615-a4f3-e2d1c0b9a887",        // 作者 id
  "author_name": "王芳",                                        // 作者显示名
  "status": "pending",                                        // pending 待处理 / processing 处理中 / resolved 已处理 / dismissed 不处理
  "anchor_lost": false,                                       // 原句已不在页面中，界面退为整页批注
  "merge_request_id": null,                                   // 正在处理它的变更请求（无则 null）
  "mr_number": null,                                          // 变更请求编号（无则 null）
  "created_at": "2026-10-24T17:40:00Z",                       // RFC3339
  "updated_at": "2026-10-24T17:40:00Z"                        // RFC3339
}
```
