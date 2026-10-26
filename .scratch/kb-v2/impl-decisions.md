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

