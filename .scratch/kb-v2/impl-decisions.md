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
