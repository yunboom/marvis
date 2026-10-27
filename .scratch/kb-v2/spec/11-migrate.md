# 11 实现分支与基线

- 从 `feat/marvis-redesign`（`9a7f600b6`）新开 worktree 和分支实现，一期的 `feat/knowledge-base`、`feat/knowledge-base-followups` 不合并、不复用（决策 99）。
- 基线里没有一期代码，不需要清理：一期的 handler、`knowledge` 包、`marvis kb` 命令、`views/knowledge`、core 知识库 API、一期的 `writeKnowledgeBases`、`autopilot.system_key` 和迁移 604–612 都不会进入新分支。
- 迁移编号：基线最大是 `603_rebrand_marvis`。知识库的迁移从 604 起编号，`*_rebrand_marvis` 顺延到最后（仓库约定 rebrand 迁移始终排最后），同步改 `scripts/rebrand-marvis.py` 的 `KEEP`、`cmd/migrate/main.go` 的并发索引表和引用迁移文件名的测试。
- 聊天、构建器、自动化、任务评论、任务令牌不改；运行时说明只新增一节。
- 提示词和平台 skill 的改动（8.2–8.6）按约定单独开 PR 给用户审阅。
