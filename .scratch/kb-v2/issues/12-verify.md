# 12: 整体验证与 PR

**What to build:** 全量检查通过，开 PR。

**Blocked by:** 01–10

**Status:** ready-for-agent

- [x] `pnpm typecheck`、`pnpm lint`、`pnpm test`、`make test` 全部通过（本地 Postgres；剩下的失败都是基线就有或环境不稳定，见 PR「验证」）
- [x] code-review skill 两轴审查并修复
- [x] 开 PR 到 feat/marvis-redesign，附决策点
