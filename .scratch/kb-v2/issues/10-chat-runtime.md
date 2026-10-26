# 10: 对话卡片与运行时说明

**What to build:** 对话里出现知识库、页面（可带块）、变更请求、批注链接时渲染成卡片（设计稿 12.x），悬停显示概要；运行时说明新增「知识库」一节（表格 slug/名称/简介）与 Mentions 一行。

**Blocked by:** 01, 08

**Status:** ready-for-agent

- [ ] mention 类型 kb / kb_page / kb_mr / kb_annotation 的前端卡片与悬停，失效时退回文字
- [ ] 任务认领响应带 knowledge_bases，daemon 写入 `writeKnowledgeBases`（文案按 spec 08.2，英文；不出现 quickstart，决策 103）
- [ ] `marvis kb schema templates` 命令（`GET /api/kb/templates` 已在票 03 实现），只输出 `schema`（决策 106）
- [ ] 运行时说明快照测试
