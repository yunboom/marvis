# 07: 知识库作业

**What to build:** 成员在「知识库作业」新建对话（开场白或直接描述），选执行智能体。新建作业不建草稿，智能体用 `kb draft create` 建草稿，再用 `kb job link-draft` 关联到作业（关联记在 `kb_job_draft`）；关联前右侧是空状态、提交审核不可用，关联后右侧实时显示草稿改动和检查，提交审核或放弃这份草稿；页面入口（批注全部交给智能体、让智能体检查本页、页面树「＋」、原始资料交给智能体收录）带入上下文（设计稿 9.x、4.x）。

**Blocked by:** 03, 04

**Status:** ready-for-agent

- [ ] `/api/kb/bases/{kb}/jobs`、`/api/kb/jobs/{id}`、submit、discard；首条消息按 spec 08.4 + 08.5 拼装（英文原文常量），带作业 id
- [ ] 迁移删 `kb_job.draft_id`，新建 `kb_job_draft`（`job_id`、`draft_id` 各一个唯一索引，各自单独迁移文件）；作业响应的 `draft_id` 从关联表读，未关联为 null（决策 104）
- [ ] `PUT /api/kb/jobs/{id}/draft`：作业创建人或作业里执行的智能体（任务令牌）可调；草稿须同一知识库且 open；重复关联同一份返回 200；`job_draft_exists`（带已关联的 `draft_id`）、`draft_linked` 409；关联后发 `kb.job.updated`
- [ ] CLI `marvis kb job link-draft <job> --draft <草稿 id>`，参数照 spec 08.1
- [ ] 作业页复用聊天消息列表与输入框，右侧草稿栏；边界情况表（9.9–9.17，9.17 为还没关联草稿：空状态、提交审核不可用）
- [ ] WebSocket 事件 kb.draft.updated / kb.job.updated 失效查询
- [ ] 端到端：发起 → 写草稿 → 提交
