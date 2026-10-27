# 6 存储、合并与一致性

6.1 块模型

- 块只有一种：一段 Markdown。保留 `kind` 字段，目前只有 `text` 一个枚举值（照飞书段落块 text 的叫法，内容仍是一段 Markdown），以后要加别的块类型时不用改结构（决策 75、76）。照飞书云文档 `--doc-format markdown`：读写都是 Markdown，服务端负责切块（本机 `lark-doc` skill 的 `lark-doc-md.md`、`lark-doc-fetch.md`）。
- 切块规则：写入时用 goldmark 按顶层结构切——一个标题、一个段落、一整张列表、一张表格、一个代码块、一段引用各成一块。每个新块分配 4 位随机 id（库内唯一）。原样存 Markdown、不转成富文本，所以不需要飞书那套特殊字符转义。
- `block_replace` 保留原块 id；一次写入的 Markdown 被切成多块时，第一块沿用原 id，其余分配新 id。
- 页头和正文分开存：`frontmatter` 是 JSON；`sources`、`generated` 由系统维护。

6.2 草稿写入

```
sequenceDiagram
  participant AG as 智能体（CLI）
  participant API as KB API
  participant PG as Postgres
  participant FE as 作业页右侧
  AG->>API: page fetch team:/payment/callback --scope section --start-block-id b7Kq --detail with-ids
  alt 这一页在本草稿里改过
    API->>PG: 读 kb_draft_page（草稿里的版本）
  else 还没改过
    API->>PG: 读 kb_page（主线版本）
  end
  API-->>AG: 块 + version
  AG->>API: page patch（version，block_replace b8Xz）
  API->>PG: 事务：锁 kb_draft 行，校验 version；<br/>第一次改这页时把主线版本复制成 kb_draft_page，<br/>再在副本上改，kb_draft.version + 1
  API-->>AG: 新 version，新块 id
  API-->>FE: kb.draft.updated（1 秒内合并发送）
```

图 3 · 智能体按块读写草稿
- 草稿按页记录：第一次改某页时把主线的块、页头、论断复制进 `kb_draft_page`，记下 `base_revision_id`；之后只改草稿行。
- 乐观锁：`fetch` 返回页面的 `version`（草稿页为 `d<草稿版本>`，主线页为修订 id）；写入带上它，不一致返回 409 `stale_version`，智能体重新读取后再改。
- 同一草稿的写入串行（锁 `kb_draft` 行），不同草稿互不影响。

6.3 合并

```
sequenceDiagram
  participant U as 知识库创建者 / owner / admin
  participant API as KB API
  participant PG as Postgres
  U->>API: POST /merge-requests/16/merge（draft_version = 9）
  API->>PG: 事务开始；锁 kb_draft；校验 version = 9
  API->>API: 草稿还有未解决的冲突则 409
  API->>PG: SELECT … FROM kb_page WHERE id IN (改动页) FOR UPDATE
  loop 每个改动页
    alt head_revision_id = base_revision_id
      API->>API: 直接取草稿
    else 主线动过
      API->>API: 按块三方合并（base / 主线 / 草稿）
    end
  end
  alt 有冲突
    API-->>U: 409 + 冲突块，事务回滚
  else 无冲突
    API->>PG: 写 kb_page_revision、更新 kb_page / kb_claim / kb_link
    API->>PG: 变更请求 merged、批注 resolved、草稿 merged、content_version + 1
    API-->>U: 200；提交后发 kb.mr.merged
  end
```

图 4 · 合并在一个事务里完成
| 情况 | 处理 | 
| 主线没动过这页 | 直接用草稿（快进） | 
| 两边改了不同的块 | 各取改动；两边在同一位置插入新块时都保留，主线的在前 | 
| 两边改了同一块且结果不同 | 冲突，报这一块在主线和草稿里的行范围（设计稿 9.12、8.6） | 
| 一边删了块，另一边改了它 | 冲突 | 
| 页头 | 按键三方合并，同一个键两边都改成不同的值才冲突 | 
| 论断 | 按 `key` 三方合并 | 
| 移动 / 改名 | `parent_id`、`position`、`slug` 按字段三方合并；同级重名报冲突 | 
| 一边删页，另一边改了这页 | 冲突 | 

- 冲突时整个合并回滚，变更请求保持 open。

冲突解决：照 git，在草稿里解决

草稿相当于分支，主线相当于 main。合并报冲突时不在合并里解决，而是先把主线合进草稿（`git merge main`），在草稿里改好冲突，再合并；这时草稿已经包含主线的改动，合并就是快进。

| 步骤 | git | 这里 | 
| 1 把主线合进草稿 | `git merge main` | `marvis kb draft sync <草稿>`：主线动过的页逐页三方合并，不冲突的直接合入；每页的 `base_revision_id` 推进到主线当前修订 | 
| 2 看冲突 | `git status` | `sync` 的输出、`kb draft check` 的 `unresolved_conflict` | 
| 3 改冲突 | 编辑带冲突标记的文件 | `kb page fetch --draft --detail with-ids` 读到带标记的块，`kb page patch --op block_replace` 写入解决后的内容 | 
| 4 标记已解决 | `git add` | 不用单独命令：改过冲突块（或冲突的页头键、位置）就清掉这一条；内容里还留着标记行的写入被拒绝 | 
| 5 提交合并 | `git push` 后合并 MR | 合并变更请求；草稿已基于主线最新修订，直接快进 | 

冲突块的内容按 git 的格式写入，主线在上、草稿在下：

```
<<<<<<< 主线
渠道回调按渠道交易号和渠道号去重。[^mar-150]
=======
渠道回调按渠道交易号加幂等键去重。[^mar-142]
>>>>>>> 草稿
```

| 冲突 | sync 后草稿里的样子 | 怎么解决 | 
| 两边改了同一块 | 块内容换成上面的冲突标记 | `block_replace` 写入最终内容 | 
| 一边删块、一边改块 | 保留改过的块，删掉的一侧为空 | 要删就 `block_delete`，要留就 `block_replace` | 
| 页头同一个键两边不同 | 先保留草稿的值，冲突里记下主线的值 | `set_meta` 写这个键 | 
| 位置 / 路径段冲突 | 先保留草稿的位置 | `kb page move` | 
| 一边删页、一边改页 | 页面恢复成改过的内容 | 要删就 `kb page delete`，要留就改任意块 | 

- 冲突记在 `kb_draft_page.conflicts`；不为空时 `kb draft check` 报 error `unresolved_conflict`，合并返回 409。
- 作业页「让智能体基于主线更新」就是往作业对话里发一条消息，让智能体执行上面 1–4 步。
- sync 后主线又有新合并：合并时照常三方合并，不冲突就直接合并；再冲突就再 sync 一次。
- 回滚一个已合并的变更请求：新建一份草稿，每页取「合并前修订」作为目标、「合并后修订」作为基准，与当前主线三方合并，生成 `source = revert` 的新变更请求。后续改动碰了同样的块就冲突（设计稿 2.9）。
- 合并时系统写 `generated`，`stale_after` 不由系统改。

6.4 一致性与持久化

| 问题 | 做法 | 
| 数据错乱 | 合并、回滚、保存配置、删库各在一个 Postgres 事务里完成；没有第二个存储需要对账 | 
| 并发合并同一页 | `FOR UPDATE` 锁改动页，按页面 id 排序加锁防死锁；后到的事务看到新的 `head_revision_id` 走三方合并 | 
| 合并了审核人没看过的改动 | 合并请求带 `draft_version`，不一致返回 409，界面提示刷新 | 
| 一直显示旧数据 | `kb_base.content_version` 每次合并 +1，接口 `ETag` 取它；前端收到 `kb.mr.merged` 失效缓存，WebSocket 重连后整体重拉 | 
| 持久化与备份 | 随 Postgres 现有备份；原始资料随对象存储。服务端无本地状态，多实例都能处理读写 | 

性能：页面、页面树、反向链接、关系图都是带索引的单表或两表查询；一个页面的块通常几十个，`fetch` 只返回需要的块。三方合并只处理改动页，每页是块数组的比较，毫秒级。
