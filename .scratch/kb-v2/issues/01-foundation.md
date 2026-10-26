# 01: 知识库底座：表结构、块模型、知识库列表

**What to build:** 成员在侧栏「知识库」看到工作区的知识库列表（设计稿 1.1、1.4 空状态）。服务端有全部 `kb_*` 表、块切分、链接解析、页面与修订读写，后续票都在它上面长。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 迁移：spec 05 的全部表与索引（含 `CREATE EXTENSION vector`、`kb_block_embedding`），从 604 起编号，每个 CONCURRENTLY 索引单独一个文件，`*_rebrand_marvis` 顺延到最后，同步 rebrand 脚本 KEEP、`cmd/migrate/main.go` 并发索引表和相关测试
- [ ] sqlc 查询；`make sqlc`、`make schema` 通过
- [ ] 块模型：Markdown 按顶层结构切块（goldmark），4 位块 id，`block_replace` 保留 id；链接解析写 `kb_link`；`search_text` 生成（spec 06.1）
- [ ] `GET /api/kb/bases`、`GET /api/kb/bases/{kb}` 与 core 的 schema / query hooks（parseWithFallback）
- [ ] web 与 desktop 都接入知识库列表页（侧栏入口、列表、空状态），照设计稿 Main / home-empty
- [ ] 块切分、链接解析单测；接口测试
