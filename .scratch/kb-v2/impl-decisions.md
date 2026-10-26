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
   - 已知：构建器指令末尾按 spec 08.3 嵌入 `{{.DefaultSchema}}` 全文，所以拼好的提示词里会以「普通页面」出现 quickstart；指令自身的文字不出现（`builder_test.go` 断言）。
2. **隐藏构建器智能体的 system_key**
   - 问题：spec 写 `kb-builder:<流程 id>`，创建智能体用的是 `agent_builder:`。
   - 选择：`kb_builder:`（`kb.BuilderSystemKeyPrefix`），与现有前缀同一写法；`DeleteSystemAgentByID`、`RebindAgentBuilderRuntime` 的守卫改为 `starts_with` 同时覆盖两种前缀（原来的 `LIKE 'agent_builder:%'` 里 `_` 是通配符）。
   - 运行时删除的阻塞提示里，知识库构建器归为 other_system（「Marvis 内置」），没有单独的文案，留作缺口。
3. **放弃与清理**
   - `DELETE /api/kb/builder/sessions/{id}` 先确认是知识库构建器会话（否则 404），再直接走现有的删除聊天会话逻辑；聊天删除路径里加了删 `kb_builder_session`，运行时下线（`pruneRuntimeSystemAgentChatDraftRestores`）也一并清理。
   - 创建成功 / 配置保存后，照创建智能体把构建器会话归档（不删），它就不再出现在「未完成」里。
4. **构建器会话接口细节**
   - 列表响应是数组（spec 原样），只列有消息或保存过右侧配置（`draft <> '{}'`）的会话；没保存过时 `draft` 为 null，前端回放最后一条 `<kb_draft>`。
   - `kb` 查询参数接受 id 或 slug；`mode` 不合法 400。
   - 配置模式建会话要求知识库创建者或 owner / admin（403），`schema_mode` 不传时取知识库当前值。
   - 更换运行时与创建智能体共用 `rebindBuilderCarrier`（锁顺序、在线检查、回复进行中 409 都一致）。
5. **默认 Schema 与目标模板的存放**
   - 问题：要求「落成 Go 常量」，但默认 Schema 含 ``` 代码块，Go 原始字符串放不下反引号。
   - 选择：英文原文放在 `server/internal/kb/templates/*.md`，用 `go:embed` 读成包级变量 `kb.DefaultSchema`、`kb.PurposeTemplate`；构建器指令是 `text/template`，建会话时按模式、slug、初始 Schema 模式渲染。
   - 新增 `GET /api/kb/templates`（返回 `default_schema`、`purpose_template`）：新建时右侧要只读显示内置 Schema，切到「自定义」也要从它起步，前端不再复制一份文本。
6. **slug 保留字**：`new` 不能作为知识库 slug（与 `/kb/new` 路由冲突），前后端一致校验。
7. **PATCH 配置**
   - `base_updated_at` 选填；传了就在行锁下比对，`updated_at` 返回到客户端只有秒级精度，所以按秒比较，同一秒内的两次保存不判冲突。
   - 一直是默认模式时保留创建时写入的模板，不随平台模板更新；从自定义切回默认时写入当前内置模板；切到自定义必须带 `schema`；名称不能改成空。
   - 创建和每次保存都写一行 `kb_config_revision`。
8. **创建后的去向（1.10）**
   - 作业页属于票 07，现在跳到 `/kb/{slug}?welcome=1`：首页上方显示「已创建」提示和四步上手引导，「收录资料」标「建议先做」，点「知道了」去掉参数。引导第一步的文字改成「新建知识库作业」，不说「在这里」。
   - 票 07 做好作业页后，把跳转改成 `/kb/{slug}/jobs/new?welcome=1` 并把引导移过去。
9. **配置保存后的去向**：设计稿 10.4 停留在配置页显示「已保存」；但保存后这段对话已经结束，留在页面会让它一直挂在「未完成的配置」里。选择：提示「已保存」、归档会话、回到知识库首页。
10. **路由**：`/kb/new`（选运行时）、`/kb/new/{会话}`、`/kb/{slug}/config`、`/kb/{slug}/config/{会话}`；选运行时这一步复用 `BuilderSetup`。配置页在 `[kbSlug]` layout 下，`KbShell` 遇到 config 路由不画知识库导航，占满宽度（设计稿 10.x）。
11. **消息信封与回填**
   - 用户消息包成 `MARVIS_KB_BUILDER_INPUT\n{user_request, schema_mode, current_draft}`，`current_draft.schema` 只在自定义模式带。
   - 回填：Schema 只在自定义模式采用构建器给的；配置模式不改 slug；新建时 slug 转小写。上一条回复改动过的字段在卡片上标「刚更新」，用户改这一项后去掉。
   - 右侧配置保存时，默认模式不存 Schema 正文；恢复时默认模式显示知识库自己的 Schema（配置且原本是默认）或当前内置模板。自定义 → 默认 → 自定义在本页内能找回刚才手写的 Schema（不持久化）。
12. **开场白**：新建的四个方向点了直接发送「{标题}：{说明}」；配置的四个问题点了直接发送问题原文。「有未保存的修改」只在配置模式显示（对比打开时的配置）。
13. **更换运行时**：设计稿在顶栏运行时旁放「更换」；做成下拉，只列在线且本人能用的运行时，先改服务端绑定再更新显示（同创建智能体）。
14. **「…」菜单里的配置入口**：只对知识库创建者和 owner / admin 显示（成员列表 + 当前用户判断，与服务端规则一致）；「知识库管理」「变更记录」「关系图」仍等票 08、09。
15. **mention**：`[名称](mention://kb/<id>)`，名称里的 `[`、`]`、`\` 转义。


## 票 04

1. **决策 104 的表结构**
   - `kb_job.draft_id`、`kb_merge_request.task_id` 直接从迁移 604 删掉，`kb_job_draft` 也并进 604；两个唯一索引是 629 `kb_job_draft_job_id_key`、630 `kb_job_draft_draft_id_key`，rebrand 顺延到 631（脚本 `KEEP`、CLAUDE.md、`concurrentIndexCleanups` 同步）。
   - 已跑过的本地库手动执行：删两列、建 `kb_job_draft`、`kb_draft_page` 加 `version`、`UPDATE schema_migrations SET version='631_rebrand_marvis' WHERE version='629_rebrand_marvis'`，再 `migrate up` 建 629 / 630。
   - 删除工作区时一并清理 `kb_job_draft`。
2. **乐观锁按页判断**
   - 问题：spec 说草稿页的 version 是 `d<草稿版本>`。如果严格要求等于当前草稿版本，智能体改完 A 页再改 B 页就会因为草稿版本变了而 `stale_version`，一份草稿改多页时几乎每次都冲突。
   - 选择：`kb_draft_page` 加 `version` 列，记这一页最后一次写入时的草稿版本；写入带 `d<n>` 时，`n` 不小于这一页的 `version`、不大于草稿当前版本就算有效。还没进草稿的页必须带主线 head 修订 id。fetch 返回的仍是 `d<草稿当前版本>`。
   - 同一草稿的写入用 `SELECT … FOR UPDATE` 锁 `kb_draft` 行串行执行；并发测试里同一版本 4 个写入只有 1 个成功。
3. **ops 的细节**
   - 一次请求里的 ops 按顺序在内存里执行，全部成功才写库；`delete` 之后不能再有操作。
   - `str_replace` 在整页里必须恰好出现一次（409 `str_replace_match`）；替换后这一块按 `block_replace` 重新切块并保留块 id，内容变空就删掉这一块。
   - `set_meta` 的值为 `null` 表示删除这个键；`stale_after` 接受日期或 RFC3339，统一存 RFC3339 UTC；改 `sources`、`generated` 返回 400 `protected_meta_key`。
   - `move` 带 `parent`（`<kb>:/` 为顶层）、可选 `after`、`slug`；不能移到自己或后代下面；同级重名 409 `duplicate_slug`；排序键用分数索引（rocicorp/fractional-indexing 的 midpoint 算法，`kb.PositionBetween`），不重排兄弟。
   - `delete` 有子页面时 409 `page_has_children`，先移走或删掉子页面；删除草稿新建的页面直接去掉这一行。
   - 写入时把路径链接按草稿的页面树解析成 `kb://`，解析不到的保留路径。
   - op 记录：新建页保持 `create`；改内容或页头为 `update`；只移动为 `move`；之后再改内容升为 `update`。
4. **冲突标记**
   - 标记行照 spec 原文 `<<<<<<< 主线` / `=======` / `>>>>>>> 草稿`；判断「还留着标记」只看以 `<<<<<<<` 或 `>>>>>>>` 开头的行，单独的 `=======` 是 setext 标题下划线，不算。
   - 写入内容含标记行返回 409 `conflict_markers`；改过冲突块（`block_replace` / `block_delete` / `str_replace` 命中）就清掉这一条，`set_meta` 清掉对应键的页头冲突，`move` 清掉位置冲突，页级冲突（一边删页一边改页）被任意块写入或删页清掉。
5. **kb draft sync 的合并规则（`kb.MergePage`，票 08 合并可复用）**
   - 块按 id 三方合并，结果以草稿顺序为主，主线独有的块插在它在主线里的前一块之后，两边在同一位置插入时主线的在前；块移动只跟草稿。
   - 页头按键三方合并，`generated` 取主线，`sources` 合并后按论断重算。
   - 论断按 `key` 三方合并，两边都改时取草稿（论断由 `claims set` 整页写入）；挂在已不存在的块上的论断丢弃。
   - `parent_id`、`position`、`slug` 逐字段合并，两边改成不同值时保留草稿并记位置冲突；合并后与同级重名也记位置冲突。
   - 冲突写进 `kb_draft_page.conflicts`：`{kind, block_id?, key?, main_value?, main_lines?, draft_lines?}`；行范围按块渲染成 Markdown 后的行号算。上一次 sync 没解决的冲突保留。
   - 只有主线动过的页才合并并推进 `base_revision_id`；有页合并时草稿版本 +1。草稿不是 open 时 409 `draft_not_open`。
6. **draft check（`GET /api/kb/drafts/{id}`）**
   - diff：基准修订和草稿各自按块拼成 Markdown（链接显示成路径）后逐行比较，每行带所在块 id；页头改动不进 diff。`change` 为 added / deleted / moved（路径变了、正文没变）/ modified，路径变了时给 `old_path`。
   - `checks.conflicts` 只列已经 sync 进草稿、还没解决的冲突（多返回 `kind`、`key`）；不做「还没 sync 时预判冲突」，那要等合并时报。
   - 格式检查只看草稿里改动过、没删除的页面。消息是英文（面向智能体，界面按 code 翻译）。
   - 链出、链入的计算：草稿页按草稿的页面树解析；链入 = 主线 `kb_link` 里来自草稿没改动的页面的链接 + 草稿页之间的链接。`isolated_page` 按「链到的其他页面数（含还没写的）少于 2」判断。
   - 写入接口（ops、新建页、claims）返回的 `warnings` 是这一页的全部检查结果（含 error）。
7. **claims**
   - `PUT …/claims` 校验 key 唯一、有 `block_id`、每条证据有 `source` 和 `uri`；`checked_at` 不传取当前时间。证据 `version` 不在写入时强制，`repo://`、`pr://` 缺版本由检查报 `missing_evidence_version` warning（与 spec 4.7 一致）。
   - 重算的 sources 写进草稿页的 `frontmatter.sources`（`{id, resource, title}`），合并时随页头进主线。
   - 新增 `GET /api/kb/pages/{ref}/claims?draft=` 给 `kb claims get` 用（spec 只给了 PUT）。
   - `undefined_footnote`：正文 `[^id]` 必须是这一块论断证据的 `source`；`[^id]:` 定义行不算引用。
8. **fetch**
   - `simple` 返回 `content`，`with-ids` 返回 `blocks`，两者互斥；`children` 是草稿叠加后的直接子页面（带 id、路径、标题）；`backlinks=true` 返回主线反向链接。
   - `section` 的起始块必须是标题块，范围到下一个同级或更高级标题前；`keyword` 不区分大小写；`context_before/after` 对 section、keyword、range 生效；超过 200 块截断。
   - `revision_id` 读历史修订，version 为修订 id；与 `draft` 同时带 400。
9. **建草稿与作业关联（决策 104 补充）**
   - 只有 `X-Actor-Source = task_token`（或通过 resolveActor 校验的智能体）时才记 `task_id`，响应不返回。
   - `job_id`：作业须在同一知识库（否则 404 `job_not_found`）；调用人是作业创建人，或调用方是作业的执行智能体且任务属于作业的对话（否则 403）；作业已有草稿 409 `job_draft_exists` 并带已关联的 `draft_id`，整个请求回滚（不留下新草稿）。
   - 成功后发 `kb.job.updated`（`protocol.EventKbJobUpdated`，payload `{job_id, knowledge_base_id, draft_id}`）。前端订阅与 `kb.draft.updated`（1 秒合并发送）留给票 07。
10. **读写权限**：草稿的读写只认 `created_by` = 调用人（任务令牌按令牌绑定的人）；草稿由智能体以令牌绑定的人建，所以和作业发起人不同人时作业发起人看不到它——票 07 做作业页时按 `kb_job_draft` 放开作业发起人。
11. **检索（决策 105）**：本票只做关键字一路：按空格分词，每个词都要命中 `search_text`（ILIKE，转义通配符），标题命中排前，返回前 `limit` 条（1–50，默认 10）和 `total`，不翻页；`type` 不区分大小写过滤；`mode` 为 `keyword`。命中块和摘录取第一个含查询词的块，摘录约 120 字。
12. **页面列表（决策 105）**：`total` 是这一层（`parent` 的直接子页面或顶层）的页面数，主线用一条 COUNT（排除草稿改过的页）加上草稿在这一层的页面数；草稿删除的页面照常列出并计数（与票 02 树的展示一致）。`type` 只在这一层过滤，主线在 SQL 里过滤，草稿页按页头 `type` 过滤，排序和游标不变。
13. **chat scope（spec 8.7）**
    - `scope=workspace` 不被允许时返回 403 `chat_scope_forbidden`，不静默退回只读自己的，免得智能体以为读到了全员对话。
    - 智能体调用时按 `agent.permission_mode = private` 且智能体主人在工作区的角色是 owner 判断。
    - 列表新增可选 `since`、`agent_id`、`limit`、`offset`：`scope=workspace` 在 SQL 里过滤分页（不含隐藏的 system 智能体会话、只列有消息的会话）；不带 scope 时只有传了这些参数才在原列表结果上过滤分页，不传时行为完全不变。消息分页加 `since`，命中更早的消息后 `has_more` 置 false。
14. **CLI**
    - 帮助文字是英文（工具描述用英文）；`kb draft create` 的说明和所有 `--draft` 说明按决策 104 的中文原文译成英文，测试锁住。
    - 出错时把服务端的 `{error, code}` 打成 `{"error": {"code", "message"}}` 输出到 stdout，退出码仍按 HTTP 状态分级；`main.go` 里 `errSilent` 改用 `errors.Is` 判断，已经打印过的错误不再往 stderr 重复。`kb draft check` 有 error 或未解决冲突、`kb draft sync` 有未解决冲突时退出码 1。
    - `kb page patch --op set_meta`：`--meta k=v` 可重复，也接受跟在页面引用后的 `k=v` 参数；`k=` 删除这个键，值以 `[` / `{` 开头按 JSON 解析，其余按字符串。
    - 服务端不分页的列表（`kb list`、`kb history --page`）在客户端按 `--limit` / `--offset` 截取。
    - `mention`：知识库对象 `[名称](mention://kb/<id>)`（列表和详情也带了），页面对象 `[标题](mention://kb_page/<id>)`（fetch、树、检索、过期页、新建页）。
    - 后续票才有服务端接口的命令（annotation、mr、raw、sources、`kb history` 不带 `--page`）先按 spec 契约接好，接口缺失时按 404 输出错误。

- 票 03 第 9 条已由用户改定：创建成功跳知识库首页；配置保存后留在配置页、提示「已保存」、会话不归档，「未完成的配置」只列有未保存改动的会话（由票 07 修正）。


## 票 05

1. **锚点丢失与原句的存法**
   - 问题：spec 7.6 响应有 `anchor_lost`，DDL 没有这一列；设计稿 5.7 要同时显示「现在的句子」和「批注时的原句」，表里只有一个 `quote`。
   - 选择：`anchor_lost` 不落列，按「挂在页面上、有 quote、block_id 为空」推出（`kb.AnnotationAnchorLost`），丢失时 `block_id` 清空即「改挂整页」，quote 保留供显示；新增迁移 631 `kb_annotation.original_quote`：跟随改写后 `quote` 是现在的句子，`original_quote` 记批注时的原句（相同时为空串）。rebrand 顺延到 632（脚本 `KEEP`、CLAUDE.md 同步）。
   - 理由：少一个和 block_id 冗余、可能不一致的状态；原句必须留存才能画 5.7。
2. **匹配用的文本**：quote 按读者看到的纯文本匹配，不按 Markdown 源：块的 `PlainText` 去掉脚注引用 `[^id]`、空白折叠为一个空格（`kb.AnchorText`）；页面文本是各块按顺序以换行拼起来，前后 32 字也按这个文本截取。前端取划选文字时去掉引用角标、折叠空白，与之一致。
3. **新建时由服务端定锚**：`block_id` + `quote` 必须在这一块里找到（否则 400 `quote_not_found` / `block_not_found`），prefix / suffix 由服务端从页面文本截取；请求里带的 prefix / suffix 只用于同一块里句子重复出现时挑哪一处。CLI 不传上下文也能用。
4. **页面的写法**：请求体除 spec 的 `page_id`，也接受 `page`（任意页面引用，id 或 `slug:/路径`），因为票 04 的 CLI 发的是 `page`；只能批注主线上未删除、属于本知识库的页面（否则 400 `page_not_found`）。草稿视图里不能划选批注。
5. **重定位的顺序**（`kb.Relocate`）：原块里找原句 → 原句一字不差出现在页面别处（不足 16 字的短句还要求前后文至少一侧挨着，免得「去重」这类词跳到无关句子）→ 前后 32 字近似匹配（编辑距离 ≤ 长度的 1/4，Sellers 算法），两侧都中取中间，只中一侧时取到句末 / 句首（。！？；.!?; 或换行）→ 原句本身近似匹配（≥6 字，编辑距离 ≤ 1/4）→ 丢失。结果裁剪在起点所在的一块内，长度不超过原句 4 倍 + 64 字。已解决的批注不再移动。
6. **重定位的接入点**：主线目前只有 `kb.CreatePage`（新页面，没有批注），还没有改写主线页面的路径；本票提供 `kb.RelocateAnnotations(ctx, q, baseID, map[页面]新块)`（一次查询加锁、内存计算、一条 unnest 批量 UPDATE，删页传 nil 全部丢失），由票 08 合并时在同一事务里调用。
7. **状态流转函数**：`kb.AttachAnnotations`（pending → processing，记 merge_request_id，只动本库的 pending）、`kb.ResolveAnnotations`（processing → resolved，保留 merge_request_id）、`kb.ReleaseAnnotations`（processing → pending，清掉 merge_request_id），给票 08 的建变更请求 / 合并 / 关闭用。
8. **不处理 / 恢复的权限**：spec 写「作者或 owner / admin」；加上知识库创建者（他本来就能合并、配置，是维护人）。智能体写的批注，作者判定按调用方是不是这个智能体。processing / resolved 返回 409 `annotation_locked`；状态没变时直接返回 200 不发事件。前端按同一规则决定是否显示「不处理」「恢复」。
9. **列表接口**：`status` 在 `pending`（默认）/ `all` 之外也接受四个具体状态；`page` 接受页面 id、`slug:/路径` 或 `-`。响应多返回 `original_quote`、`block_index`（第几段，设计稿「支付回调 · 第 2 段」）和 `mention`（`[批注 · 页面标题](mention://kb_annotation/<id>)`，整库批注只写「批注」）。
10. **事件**：`kb.annotation.changed`，payload `{knowledge_base_id, annotation_ids, page_ids}`；新建、不处理、恢复时发。前端收到后失效批注列表、首页、阅读页、页面树和知识库列表（计数都在这些查询里）。重定位和变更请求带来的状态变化由票 08 在提交后发同一事件。
11. **界面**
    - 阅读页：划选同一块里的文字（草稿改动的块、跨块不算）出「批注」按钮，点开在原处写批注（5.1、5.2），提交后打开本页批注栏；页头加批注按钮（带待处理数），打开右侧「本页批注 N」：列待处理和处理中的批注（含原句已删除、改挂整页的），最后是「添加批注」（5.3、5.4）；栏开着时正文里标出被批注的句子（句子跨了 Markdown 标记时标不出，只在栏里显示）。
    - 知识库首页：页头加批注按钮（带整库批注数），打开「知识库批注 N」（5.5、5.6）；待处理卡片里的「批注」改成链接到批注列表。
    - 批注列表 `/kb/{slug}/annotations`（2.3、5.7）：分段 Tabs 待处理 N / 处理中 N / 已解决 / 不处理，一次取 `status=all` 在前端分组；每行显示位置（链接到页面并定位到块）、「已跟随改写」「原句已删除」、处理中的 `#编号`、批注时的原句。
    - 「交给智能体处理」「全部交给智能体（N）」按钮只占位（禁用），点击行为在票 07 建作业时接上。
    - 2.4「点批注跳到页面对应句子」用已有的 `#块id` 定位并闪一下，没做句子级高亮滚动。


## 票 06

1. **不加迁移**：票 01 的 605、606、627、628 已经按条件建好扩展、`kb_block_embedding` 和 HNSW / 知识库索引，本票只加查询（`kb_embedding.sql`），rebrand 仍是 632。
2. **embedding 客户端不用 OpenAI SDK**
   - 问题：`pkg/llm` 的测试锁住「只有 llm 包能 import openai-go」。
   - 选择：`pkg/embedding` 直接用 `net/http` 调 `{BASE_URL}/embeddings`，`BASE_URL` 与 `MARVIS_LLM_BASE_URL` 同样含 `/v1`；请求带 `dimensions: 1024`、`encoding_format: float`；按 `index` 排回输入顺序，条数或维度不对报错；客户端本身不重试（检索路径 2 秒超时直接降级，建向量由 worker 退避重试）。错误信息带状态码和上游正文前 300 字节，不含密钥；启动日志只打 `enabled` 和模型名，不打地址（地址可能带令牌）。
   - 一批固定 100 条（spec）。少数网关单批上限更小（如通义 text-embedding-v3 是 10 条），这种情况会一直报错、退回关键字，暂不加配置项，留作缺口。
3. **建向量的入口与时机**
   - `kb.EmbeddingIndexer`：`Enqueue(页面 id...)` 不阻塞，只把 id 放进待办集合；`Run` 在后台消费。写主线的调用方（票 08 合并、`kb.CreatePage` 的调用方）在事务提交后调 `h.KbEmbeddings.Enqueue`，`CreatePage` 的注释写明了这一点。目前主线没有生产调用方（票 03 去掉了 quickstart 页），所以本票只提供入口。
   - `IndexPages(页面 id)` 是可复用的同步入口：一次查页面、一次查已有 hash，内存里比对；块纯文本（`kb.PlainText`，截到 4000 字）的 sha256 与模型都没变就跳过；删掉的块、删除的页面一条批量 DELETE；需要重算的块按 100 条一批，一批一次 embedding 调用加一次 unnest 批量 upsert（循环只按批次走，注释写明是上游单批上限）。最后把这些页的向量 `updated_at` 刷成 now()，作为「已建到这一版」的标记。
   - 补算：启动时和每 10 分钟跑一次 `Backfill`：先删已删除页面的向量，再按页面 id keyset 分批（100 页）找「没有当前模型的向量、或有别的模型的向量、或向量比页面 `updated_at` 旧」的页面重建。第一次配置、换模型（换模型要改环境变量重启）、以及丢失的 Enqueue（进程重启）都由它兜底。按页面 id 而不是「按知识库」分批：效果相同、keyset 更简单。没有文字可建的页面每轮都会被扫到一次，代价只是一次读。
   - 失败指数退避：2 秒起翻倍，最长 5 分钟；失败的页面放回待办。
   - 没配模型或没有 pgvector（`to_regclass`）时 worker 直接退出，`Enqueue` 什么都不做。
4. **检索的两路与融合**
   - 关键字一路沿用票 04 的 SQL，只是取前 50 页；每页挑一个代表块：含查询词的块里向量一路排名最靠前的那个（这样两路找到的是同一块时分数能相加），否则第一个含词的块；只有标题命中时块为空。
   - 向量一路：查询词整句 embedding（2 秒超时），在只读事务里 `SET LOCAL hnsw.iterative_scan = relaxed_order`，materialized CTE 取前 50 块、外层 `ORDER BY distance + 0`（README 原文写法）；工作区、知识库、模型、页面未删除、`type` 都在 CTE 里过滤，所以 type 过滤两路都生效。
   - 距离阈值：余弦距离大于 0.65（相似度低于 0.35）的块丢掉。不设阈值的话向量一路对任何查询都会返回最近的 50 块，「没有结果」永远出不来。阈值是常量 `kbVectorMaxDistance`，按模型效果再调。
   - 融合 `kb.FuseRRF`：块分 = Σ 1/(60+名次)，同一路里重复的块只按最好名次算一次，按页取最高分的块，分数相同保持首次出现顺序（关键字一路在前）。`score` 原样返回。
   - `total` = 关键字命中的页面数（COUNT）+ 向量一路找到、但关键字不匹配的页面数；关键字一路已经拿全（COUNT ≤ 50）时直接判定，否则对这些页面再查一次是否匹配。
   - 降级：没配模型、表不存在、embedding 报错或超时、向量 SQL 报错都退回关键字，`mode=keyword`；后几种打一条 Warn 日志（降级就是处理，但运维需要看到）。向量一路正常跑完但没有结果时仍是 `hybrid`。
5. **响应多返回 `parents`**：设计稿 6.1 每条结果标题旁是「产品与业务 / 支付」（上级页面标题），spec 的 `path` 是 slug 路径，所以命中多返回 `parents`（上级标题数组，顶层在前），只增字段。`type`、`mention` 沿用票 04。
6. **CLI**：`kb search` 的 JSON 原样带 `mode`、`score`；表格输出第一行打 `mode: hybrid  total: N`。
7. **界面**
   - 设计稿 6.1 / 6.2 是知识库首页顶栏搜索框下拉出来的结果面板，不是独立路由，所以没有新路由：首页在 web 和 desktop 都已接入，组件 `KbSearchBox` 放在 `packages/views/kb/components/kb-search.tsx`。
   - 输入停顿 250ms 后查询，只搜当前知识库（`kb=slug`），取前 10 条；面板头是「N 个页面」（`total`），每条是标题、上级路径、摘录（查询词加粗），点开跳到页面并定位到命中块（`#块id`），只有标题命中时跳到页面顶部；回车打开第一条，Esc 或焦点离开关闭；没有结果显示「没有找到「q」」「换个关键词试试。」；请求失败显示「搜索失败」。`mode` 不在界面显示。
   - 搜索框 220px，聚焦时展开到 300px（设计稿 2.1 与 6.1 的宽度）；面板 460px 右对齐。
   - 查询键在 `kbKeys.searches(wsId)` 下，票 08 合并事件要一并失效它（spec 09「检索」）。
