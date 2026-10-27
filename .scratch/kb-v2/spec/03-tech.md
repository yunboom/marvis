# 3 技术选型

| 问题 | 选择 | 没选的 | 理由 | 
| 内容存在哪 | Postgres：页面表 + 只追加的修订表 | git 仓库 | Outline、BookStack、Docmost、Wiki.js 都把正文存数据库、用修订表记历史；浏览不用为 git 另建读模型，备份和一致性随 Postgres（决策 57） | 
| 正文结构 | 块数组 `[{id, kind, content}]`，块只有一种：一段 Markdown（照飞书 `--doc-format markdown`），按顶层结构切块；保留 `kind` 字段，目前只有 `text` 一个值（照飞书段落块的叫法） | 整页一段 Markdown | 块 id 当读写锚点参考飞书云文档 CLI（`docs +fetch --detail with-ids`、`docs +update --command block_replace --block-id`）；块内存 Markdown 和按块合并是自研，没有核实过的开源先例（开源实现调研中） | 
| 多人改同一页 | 草稿 + 审核 + 按块三方合并 | Outline 的 Yjs 实时协同 | Outline 用 CRDT 自动合并、没有审核（Hocuspocus 把文档状态存 `documents.state`）；我们要「草稿 → 待审核 → 生效」，开源产品里没有现成实现，自研 | 
| 冲突粒度 | 块 | 行 / 整页 | 块是智能体写入的单位；同一块两边都改才冲突，界面上报到块对应的行 | 
| 智能体怎么改 | 照飞书 CLI：`fetch --scope outline|section|keyword --detail with-ids` 读局部，`patch` 按块替换 / 插入 / 删除 / 移动，带版本号乐观锁 | 拉整份文档到本地再推 | 不需要把整个知识库拉到本地；版本号防止覆盖 | 
| 链接 | 存 `kb://页面id#块id`，读写时与路径互转；反向链接写 `kb_link` | 存路径 | 页面移动、改名不断链；指向还没写的页面也能存 | 
| 检索 | 混合检索：关键字一路照抄任务检索（`LOWER(col) LIKE` + pg_bigm / pg_trgm GIN 索引），向量一路用 pgvector HNSW，RRF 融合（决策 100） | 内存 BM25、zhparser、只用关键字 | 现有代码可直接复用（`9a7f600b6` `server/internal/handler/search.go:21`、`:113` `runSearchQuery`，迁移 032 / 137）；向量检索第一期不做（决策 61），镜像已是 pgvector，后续可加 | 
| Markdown 解析 | goldmark 切块、取页头、脚注、链接 | 正则 | 块切分、引用、链接都依赖可靠的 AST | 
| 导出格式 | OKF v0.2 bundle，相对路径链接 | 静态站点、git 仓库 | OKF 允许 zip 分发；相对链接在 OKF、Obsidian、GitHub 里都能用 | 
| 对话 | 现有聊天会话 + 聊天组件 | 新写对话页 | 决策 47：交互与聊天完全一致 | 
| 实时刷新 | WebSocket 事件使 TanStack Query 失效 | 轮询 | 仓库约定：事件只失效缓存 |
