# 11: 提示词与平台 skill（单独 PR）

**What to build:** 把 spec 08.2–08.6 的提示词和 marvis-platform `references/knowledge-bases.md`、SKILL.md 路由行、mentions.md 补充落到代码，单独一个 PR 给用户审。除默认 Schema 外，提示词和 skill 都不出现 quickstart（决策 103）。

**Blocked by:** 03, 07, 10

**Status:** ready-for-agent

- [x] 从 feat/kb-v2 拉独立分支，只含提示词与 skill 改动
- [x] 构建器指令按决策 106 精简，建知识库的方法进 `references/knowledge-bases.md`
- [x] 快照测试更新
