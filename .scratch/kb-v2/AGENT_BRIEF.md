# 知识库 v2 实现说明（每张票的子任务先读）

## 在哪干活

- 仓库 worktree：`/Users/mayunpeng/GolandProjects/marvis/.claude/worktrees/kb-v2`，分支 `feat/kb-v2`，基线 `feat/marvis-redesign`（9a7f600b6），没有一期知识库代码。不要切分支、不要新建 worktree、不要 push。
- 先读仓库的 `AGENTS.md`、`CLAUDE.md`，以及用户全局规范 `/Users/mayunpeng/.claude/CLAUDE.md`（Go 错误处理用 pkg/errors、空行分段、禁止魔法值、不在循环里调外部资源、golangci 增量零告警、注释中文等）。仓库 `AGENTS.md` 写的「Code comments are English」与全局规范冲突时，以仓库为准（代码注释用英文），提交信息用英文。

## 依据

- 技术方案（按章节导出）：`.scratch/kb-v2/spec/`。01 结论、02 架构、03 技术选型、04 格式与默认 Schema、05 数据模型（DDL）、06 存储与合并、07 功能与接口（最大）、08 CLI 与提示词、09 事件、10 权限、11 分支与基线、12 实施拆分。接口契约、字段、错误码以它为准。
- 设计稿：`.scratch/kb-v2/design/*.dc.html`（`canvas.json` 里有每块板的编号和标题）。界面照它做，文案照它写。部分只引用其他板的小文件不在本地，看 canvas.json 的标题即可知道它展示什么状态。
- 票：`.scratch/kb-v2/issues/`。只做你这张票的范围；发现前置票留下的缺口可以补，但要在报告里说明。
- 方案和设计稿都没写清时，按最佳实践自己决定，不要停下来问。每个决定追加到 `.scratch/kb-v2/impl-decisions.md`：问题、选择、理由、票号。

## 约定

- 后端：Go、Chi、sqlc（改 SQL 后 `make sqlc`）、迁移规则见 AGENTS.md（不建外键、每个 CONCURRENTLY 索引单独一个迁移文件）。handler 放 `server/internal/handler/kb_*.go`，领域逻辑放 `server/internal/kb/`。复用现有模式（任务检索、创建智能体的构建器、任务评论触发、聊天接口），先读现有代码再写。
- 前端：core 放 API / schema（zod + parseWithFallback）/ query hooks，views 放页面与组件（不用 next/*、react-router-dom），web 路由在 apps/web，desktop 路由在 apps/desktop，两端都接入。用 packages/ui 的组件和 token。
- 提示词与平台 skill 文案不在这些票里（票 11 单独做）；需要占位时用 spec 08 的英文原文常量即可。
- 测试：后端 `make test` 依赖本地 Postgres（容器 marvis-postgres-1 已在跑，用 worktree 的环境脚本和 `.env.worktree`，不要拷主仓库 `.env`）；前端 `pnpm typecheck`、`pnpm lint`、`pnpm test`（可先跑相关包）。新代码要有测试。先在基线跑一遍对比，只认新增的失败。
- 改完跑 `golangci-lint fmt` 和 `golangci-lint run --new-from-rev=<票开始前的提交> <改动的包>` 零告警。

## 交付

- 用小而原子的 conventional commits 提交到 `feat/kb-v2`，每条提交信息末尾加：

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013GSPM4YmkDvbkAckKimWc9
```

- 把票文件里完成的验收项勾上（`- [x]`），一起提交。
- 最后回报：做了什么、跑了哪些检查和结果（失败要原样说明）、新增的决策点、留给后续票的缺口。
