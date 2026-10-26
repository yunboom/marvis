# 07: 知识库作业

**What to build:** 成员在「知识库作业」新建对话（开场白或直接描述），选执行智能体，右侧实时显示草稿改动和检查，提交审核或放弃；页面入口（批注全部交给智能体、让智能体检查本页、页面树「＋」、原始资料交给智能体收录）带入上下文（设计稿 9.x、4.x）。

**Blocked by:** 03, 04

**Status:** ready-for-agent

- [ ] `/api/kb/bases/{kb}/jobs`、`/api/kb/jobs/{id}`、submit、discard；首条消息按 spec 08.4 + 08.5 拼装（英文原文常量）
- [ ] 作业页复用聊天消息列表与输入框，右侧草稿栏；边界情况表（9.9–9.16）
- [ ] WebSocket 事件 kb.draft.updated / kb.job.updated 失效查询
- [ ] 端到端：发起 → 写草稿 → 提交
