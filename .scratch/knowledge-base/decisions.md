# 知识库：实现过程中自行决定的事项

用户授权「需要咨询的点记录下来，按最佳实践自己选」。每条写清楚问题、选择和理由；用户 review PR 时可以逐条推翻。

## 流程

1. **issue tracker**：仓库没有配置 tracker（没有 `/setup-matt-pocock-skills` 的产物）。选用 skill 自带的本地方案，spec 和 ticket 写在 `.scratch/knowledge-base/`，随 PR 提交。
2. **测试接缝确认**：to-spec 要求和用户确认接缝；按授权跳过确认，选用下面「测试」一节的接缝。
3. **ticket 拆分确认**：to-tickets 要求和用户确认粒度和阻塞关系；按授权跳过，拆成 10 个纵向切片（`issues/01`–`10`），按阻塞顺序实现。
3a. **分支**：实现分支 `feat/knowledge-base` 从 PR #4（术语表 + ADR 0002）的分支拉出，PR 目标 `feat/marvis-redesign`，因此包含 PR #4 的两个文档提交。

## 架构

4. **知识库会话的执行载体**：照搬 agent builder——每次发起操作创建一个隐藏的系统 agent（`kind=system`，`system_key` 前缀 `kb-session:`），沿用维护智能体的运行时和模型，指令是「维护智能体原有指令 + 知识库维护说明」，再为它建一个聊天会话。理由：现有对话列表、每日沉淀读取对话时都按 `kind=user` 过滤，隐藏会话天然不会出现在「我的对话」里，也不会被沉淀回知识库；消息收发、流式输出、停止全部复用聊天链路。代价：维护智能体自带的 skill 不会随会话带过去。
5. **托管仓库**：服务端用 git 命令行在 `MARVIS_KB_REPO_DIR`（默认数据目录下 `knowledge/`）为每个工作区维护一个 bare repo；运行镜像补装 git。不用 go-git：合并冲突检测要用 `git merge-tree --write-tree`，命令行实现最直接，daemon 本来就依赖 git。
6. **智能体读写仓库**：服务端用 `git http-backend`（CGI）提供 smart HTTP，路径在 API 鉴权之后，沿用 PAT / 任务 token；`marvis kb clone` 负责带上鉴权头。推送只允许 `refs/heads/kb/*`，主线由 pre-receive 钩子拒绝。
7. **合并**：服务端 `git merge-tree --write-tree main <分支>` 判断冲突，无冲突时 `commit-tree` + `update-ref` 快进主线，不需要工作区。
8. **变更请求的 diff**：服务端按 `git diff main...<分支>` 计算，按「知识库目录」分组返回；行评论锚定在「文件 + 新文件行号」，变更请求更新后评论保留但标为「已过时」由前端显示。
9. **每日沉淀任务按需创建**：autopilot 的执行者字段非空，工作区刚创建时没有智能体，无法预先建出这条自动化。改为管理员第一次在「每日知识沉淀」配置里选好执行者并启用时创建，带 `system_key = knowledge-digest`；之后不能删除，没有知识库时不能启用。
10. **页面解析**：frontmatter 用 YAML，正文按 markdown 段落切成句子（中文按「。！？」，英文按 `. `）作为批注锚点；论断文件 `.claims/<页面>.json` 按 OKF v0.2 + OpenWiki 的字段（`id`、`text`、`evidence[{uri, version}]`）。

15. **迁移一次建全**：知识库所有表和 autopilot 的 `system_key` 放在同一组迁移（604–609），rebrand 顺延到 610；避免每个 ticket 都重排一次 rebrand 编号。
16. **内置知识库在首次打开时生成**：不改工作区创建流程，工作区第一次请求知识库接口时注册仓库并生成「团队知识库」（slug `team`）。`knowledge_repo` 行存在即表示已生成过，删光知识库后不会再自动生成。purpose.md 由工作区名称、描述和请求者「关于你」的角色与用途拼成。
17. **删除只能在界面上做**：接口要求 owner/admin，并拒绝机器凭证（任务 token、cloud PAT）；CLI 不提供删除命令。用户自己的 PAT 和网页会话在服务端无法区分，因此「只有 UI 能删」靠 CLI 不暴露命令来保证。
18. **目录名**：未指定 slug 时由名称生成小写 ASCII；中文等非 ASCII 名称生成 `kb-N`。
19. **变更请求记录涉及的知识库**：`kb_slugs` 列在创建 / 更新时由 diff 写入，删库时一条 SQL 关闭相关变更请求，不必逐个算 diff。

20. **页面「需要关注」的标记**：服务端拿不到代码仓库，无法自己算论断过期。页面树上的提示点 = 该页未处理的智能体批注数（保鲜和 `kb stale` 记下的发现）或已过 `stale_after`；不再单独存「过期论断数」。
21. **搜索不建索引**：每次按主线提交读出全部页面、建 BM25 倒排，结果按提交缓存（最多 32 个提交）。几百页规模下够用，页面多了再换持久索引。
22. **克隆地址固定**：所有工作区都用 `/api/knowledge/git/workspace.git`，由鉴权后的工作区决定真实仓库；CLI 每条 git 命令临时带 `http.extraHeader`，凭证不写进本地 clone。
23. **更新变更请求时强推**：`kb change update` 对自己的 `kb/*` 分支 `--force` 推送，因为 `kb sync` 的 rebase 会改写分支；分支只属于这一个变更请求。

## 范围（本 PR 未做，列为后续 ticket）

11. **关联外部仓库**：一期只做内部托管。外部仓库需要把 PR 读写、合并同步和推送完整历史接到 GitHub / GitLab / Gitea 三套集成上，工作量与本 PR 相当，单独做。设置页显示该选项但不可选。
12. **开局对话写 purpose.md**：开局对话代码仍叫 mika（改名放在后面做），本 PR 不改开局流程；内置库的 purpose.md 用工作区名称和创建者的「关于你」答案生成。
13. **导出静态站点**：只做下载 zip；静态站点生成后续再做。
14. **向量检索**：按共识不做；`kb search` 是中文二元切分 + BM25。
