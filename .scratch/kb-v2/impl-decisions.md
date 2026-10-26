# 实现决策记录

实现中遇到方案和设计稿没写清的地方，按最佳实践自行决定的点都记在这里，每条写明：问题、选择、理由、涉及的票。

## 票 01

1. **pgvector 不是所有库都有**
   - 问题：spec 05 无条件 `CREATE EXTENSION vector`，但桌面端单机模式的 Postgres（zonky 打包）不带 pgvector，迁移失败会导致后端起不来。
   - 选择：
     - 605（建扩展）只在 `pg_available_extensions` 里有 vector 时执行；
     - 606（`kb_block_embedding`）、627、628（向量索引）只在扩展已装时执行；
     - 其余环境记为跳过，检索退回只用关键字；
     - 恢复步骤写在 `cmd/migrate/README.md`。
   - 理由：照仓库已有的 pg_bigm 条件迁移做法；spec 07.7 本来就要求没配模型时退回关键字。票 06 读这张表前要先用 `to_regclass('kb_block_embedding')` 判断它是否存在。
2. **检索索引的两种写法**
   - 问题：spec 只写了 bigm 索引，注释里说扩展缺失时退到 pg_trgm。
   - 选择：拆成 625 `kb_page_search_bigm`（有 pg_bigm 时建）和 626 `kb_page_search_trgm`（没有时建），两者互斥。
3. **迁移编号**
   - 604：全部表，一个文件；
   - 605–606：向量扩展和向量表；
   - 607–628：每个索引一个文件，全部登记进 `concurrentIndexCleanups`；
   - 629：rebrand。脚本的 `KEEP` 和 CLAUDE.md 同步改成 629。
4. **sqlc 里 vector 列的类型**
   - 问题：sqlc 默认把 vector 列映射成 `pgvector-go` 的类型，会引入新依赖。
   - 选择：`kb_block_embedding.embedding` 覆盖成 Go `string`（pgvector 的文本格式），票 06 需要时再换。
5. **块 id 格式**：`b` 加 3 位 `[0-9A-Za-z]`，例如 `b7Kq`，与 spec 示例一致，约 23.8 万个组合。
   - 唯一性按知识库算：分配时排除主线页面和该库所有草稿页里已经用过的 id（`ListKbPageBlockIDs`）。
   - 随机数用 crypto/rand，最多重试 1000 次。
6. **切块用纯 CommonMark**
   - 不开 GFM 表格扩展。表格在 CommonMark 里会解析成一个段落，本来就是一块；开扩展后表格节点没有位置信息，反而难以切出原文。
   - 单独一行的链接引用定义（`[r]: url`）自成一块。
   - 块内容保留原文，只去掉末尾空行；`JoinBlocks` 用空行把块拼回整页。
7. **链接解析**
   - 识别两类链接：
     - `kb://<uuid>[#块]`；
     - 以 `/` 开头的路径（`.md` 可省略，`#^块id` 指向块，支持 URL 编码）。
   - 其他链接不进 `kb_link`：网址、`raw://`、相对路径。
   - 路径能解析到页面的，改写成 `kb://`；解析不到的保留原样，`to_page_id` 为 NULL。
   - 改写只匹配完整的目标地址，`/a.md` 不会误改 `/a.md#^b1`。
   - 已知限制：同一块里如果有一段行内代码，文字恰好和真实链接的 `](目标` 一样，也会被改写。
8. **search_text 的生成**
   - 第一行是标题，之后每块一行纯文本。
   - 保留：链接文字、行内代码、代码块内容、自动链接。
   - 去掉：Markdown 标记、链接地址、HTML。
9. **列表接口多返回 `pending` 字段**
   - 问题：设计稿 1.1 的列表有「待处理」列和「待审核修改 N」，但 spec 7.1 的列表响应里没有这些数。
   - 选择：列表和详情都多返回 `pending: {annotations, stale_pages, open_mrs}`，口径同 7.2 首页，按知识库批量查询。只是新增字段，向后兼容。
   - 侧栏「知识库」的徽标数 = 各知识库 `open_mrs` 之和（设计稿里的 3 就是「待审核修改 3」）。
10. **列表页的交互细节**：
    - 搜索框目前只在前端按名称、slug、简介、名称拼音过滤知识库；页面检索在票 06 做，占位文字照设计稿写。
    - 「最近更新」按钮是一个下拉，两个选项：最近更新（默认）和名称；选择不持久化。
    - 行尾「…」菜单目前只有「复制链接」（7.3），配置、删除等后续票再加。
    - 「待审核修改 N」只是文字，不是链接，等票 08 的审核列表路由出来后再改成链接。
    - 「新建知识库」链接到 `/{ws}/kb/new`，点整行跳到 `/{ws}/kb/{slug}`。这两个路由分别由票 03、票 02 注册，在那之前点进去是 404。
11. **列表页的版式**：复用现有 collection-page 和 ListGrid 的列表样式，表头 40px、行高 64px，与小队、Skills 列表一致，不照抄设计稿里的 hex 值。窄屏（窄于 `@2xl`）隐藏「简介」「待处理」两列。
12. **错误处理**：`internal/kb` 用 `pkg/errors` 包装错误并往上抛；handler 是调用链的顶层，遇到 500 时在这里用 `slog` 打印带堆栈的错误（`%+v`），与仓库 handler 的现有写法一致。
14. **删除工作区时清理知识库表**：`kb_*` 表没有外键，不会随工作区级联删除，因此在删除工作区的步骤里加了一步「delete knowledge bases」，逐表删除；`kb_block_embedding` 先判断表存在再删。所有 kb 表都登记进了 `workspaceDeletionManifest`。对象存储里原始资料文件的清理留给票 09。
13. **页面写入的预留接口**：`kb.CreatePage` 在调用方的事务里写入首个修订、`kb_page`（含 `search_text`）和 `kb_link`。票 03 建 quickstart 页、票 08 合并新页面都可以直接用；`ReplacePageLinks`、`ResolveLinks`、`RewriteLinkDestinations` 留给合并和 fetch 时的链接互转。


## 票 02

1. **阅读页路由**
   - 问题：spec 7.4 说块里的 `kb://` 链接「换成前端路由」，没定路由形态。
   - 选择：
     - 首页 `/{ws}/kb/{slug}`，阅读页 `/{ws}/kb/{slug}/p/{页面 id}`，单次修改 `/{ws}/kb/{slug}/p/{页面 id}/history/{修订 id}`；
     - 服务端把 `kb://页面id#块id` 改写成不带工作区的 `/kb/{slug}/p/{页面id}#{块id}`，前端链接处理器本来就会给 `/kb/…` 补上当前工作区；
     - 用页面 id 而不是路径做路由：页面移动、改名后链接不失效。
   - 草稿视图用查询参数 `?draft=<id>`，页面树和阅读页都读它；树上的链接保留这个参数。
2. **读页接口多返回的字段**（只增不改，向后兼容）
   - `knowledge_base_id`、`reserved`、`updated_at`、`stale`（过了 `stale_after`）、`draft_change`、`pending_mr_count`（横幅「本页有 N 个待审核的修改」）。
   - `claims[].text`：「需要复核」时标黄要用原句。
   - `sources[].version`、`sources[].raw`：悬停卡片显示核对版本；原始文件显示文件名、上传人、日期、页码（3.7）。`raw` 按 `raw://sources|assets/<文件名>` 在本库 `kb_raw` 里查，查不到时 `openable=false`、`raw=null`。
   - `drafts`：当前用户还在进行中（open / submitted）的、改了这一页的草稿，按更新时间倒序，带来源（作业的对话名、建草稿的任务对应的任务标题或对话标题）和改动块数，给草稿条和多份草稿下拉（3.9–3.10）用。
   - `last_mr.author_type / author_id`：页头头像要用。
3. **来源能否打开（openable）**
   - task：工作区里存在这个编号的任务（`task://MAR-142` 取末尾数字，不校验前缀）；
   - chat：会话是当前用户发起的（沿用 `loadChatSessionForUser` 的发起人规则，不再叠加私有智能体检查）；
   - raw：本库有这个文件；repo / pr / web：总是可打开；未知 scheme：不可打开。
   - 代码来源（repo）没有仓库地址映射，悬停卡片只显示路径和行号，不画「在代码仓库中打开」。
4. **sources 的顺序与脚注**
   - 来源由论断生成，按论断所在块的顺序排，同一脚注 id 取第一条证据。
   - 阅读页把 `[^id]` 换成编号 `[n]`，悬停出卡片；只由脚注定义组成的块（`[^id]: …`）不显示，页尾的「引用来源」列表代替它。
   - 指向还没写的页面的路径链接（`/x.md`）显示为灰色虚线、不可点。
5. **页面树叠加草稿**
   - 主线一级按 `(position, id)` 键集分页、多取 1 条，排除草稿动过的页面；草稿里落在这一级的页面在内存里按同一排序键合并、按游标过滤，再截取一页，翻页不重不漏。
   - `child_count` 在主线计数上按草稿调整：移走的减、新建和移入的加；草稿删除的页面仍计入（树上照样列出并标「删」）。
   - quickstart 不进树，草稿里的 quickstart 也不进。
   - `draft` 参数在树和读页上都只允许草稿发起人使用（403），不属于这个知识库的草稿按 404。
6. **读页的引用形式**：`{id}` 接受页面 id 和 `slug:/路径`（路径可带 `.md`），客户端要 URL 编码；只有路径没有 slug 时 400。带 `draft` 时路径按草稿的树解析，草稿新建的页面也能按 id 或路径读到。
7. **页面历史**
   - `GET /api/kb/pages/{id}/history` 一次读出全部修订，在服务端两两相邻做行级 diff 算增删行数；
   - 「查看一次修改」spec 没给接口，新增 `GET /api/kb/pages/{id}/history/{revision_id}`，返回这条修订、上一修订 id 和按 3 行上下文切好的 hunk，每个 hunk 带它上方最近的标题（设计稿 7.2 卡片头）；
   - 正文按块拼回 Markdown，`kb://` 链接显示成路径（`/a/b.md#^块`），与智能体读到的一致；删除页面的修订按空文本算；
   - 历史条目多返回 `author_type / author_id / merged_by / annotations / current`（头像、「处理批注 N 条」「当前版本」）；初始修订 `mr_number` 为 null，界面显示「初始版本」；
   - 行级 diff 自己实现（公共前后缀 + LCS），超过 400 万格时退化为整段删除 + 整段新增，不引入新依赖。
8. **首页**
   - `pending` 多返回 `latest_mr {number,title}`（设计稿卡片「最近：……」）；`agent_reported` 是作者为智能体的待处理批注数。
   - `running_jobs`：作业的对话里有排队、已派发、运行中、等待本地目录的智能体任务即算运行中。
   - 首页拿到 quickstart 后写进 `kbKeys.page(ws, id, "")`，从树里点进 quickstart 不再请求。
   - 卡片目前不是链接：待审核列表（票 08）、批注列表（票 05）、需要复核列表的路由还没有；「全部处理」按钮（票 07 建作业）和顶栏的「在本知识库搜索」（票 06）先不画。
9. **阅读页的交互范围**
   - 有：目录、页面信息、页面历史（「…」菜单打开右侧面板）、复制链接、待审核横幅、草稿条（已发布 / 草稿切换、多份草稿下拉）、草稿改动行内显示、引用悬停、需要复核标黄。
   - 先不画，等对应票：批注按钮和批注面板（票 05）、「让智能体检查本页」和树上的「＋」（票 07）、待审核横幅的「查看修改」和历史页的「回滚这次修改」（票 08）、知识库导航里的「知识库作业」入口（票 07）、「…」菜单里的配置 / 管理 / 变更记录 / 关系图（票 03、08、09）。
   - 原始文件的「打开文件」「下载」通过 `rawFileActions` 回调接入，KbPageView / KbHomePage 收这个参数；内容接口在票 09，届时在 web 和 desktop 路由里传入附件预览弹窗。没传回调时卡片只显示文件信息。
10. **草稿改动的行内显示**
    - 草稿和已发布按块 id 对齐：新块绿底、删掉的块删除线红底、改过的块先做字词级 diff（中日韩按字、拉丁按词）；
    - 改动碰到 Markdown 语法字符（链接、强调、换行等）时不做行内 diff，改为上下两块整段对照，避免拆坏 Markdown。
11. **页面树的状态**：展开状态放在 KbShell 的组件状态里（web 是路由 layout，desktop 是父路由元素，切页面不重置）；打开页面时按 breadcrumb 把各级祖先一起展开，各级同时请求。一级超过 200 条时末尾有「加载更多」，滚动到可见时自动加载。
12. **kb:// 改回路径**：新增 `kb.PathLinks(blocks, tree)`，历史 diff 已在用；票 04 的 fetch 直接用它即可。


## 票 03

1. **决策 103：quickstart 去特殊化（用户要求）**
   - 首页即总览页（知识库信息、待处理、最近变更），不再嵌入任何页面正文；首页接口去掉 `quickstart` 字段。
   - 创建知识库不再建 quickstart 保留页，也不写它的初始修订。
   - 删掉 `kb_page.reserved` 列及 CHECK（直接改迁移 604，分支未上线；已跑过的本地库手动 `ALTER TABLE kb_page DROP COLUMN reserved` 或重建）、sqlc 里所有 `reserved` 条件和 `GetKbQuickstartPage`、`kb.Reserved*` 常量、`NewPage.Reserved`、页面 / 树响应的 `reserved` 字段；名为 quickstart 的页面和其他页面一样进页面树、计入 page_count、可删可移。
   - 前端去掉 `KbPage.reserved` / `KbTreePage.reserved` / `KbHome.quickstart`、首页写 quickstart 缓存的逻辑、`KbPageBody` 的 `bare` 属性。
   - 默认 Schema 常量保留 quickstart 作为建议的普通页面（任务导航 + 待补），去掉「是首页」「Agent 依赖，不能删除、不能移动」以及 Agent 依赖清单里的 quickstart；构建器指令不出现 quickstart。
