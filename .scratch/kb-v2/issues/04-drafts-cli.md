# 04: 草稿读写与 marvis kb CLI

**What to build:** 智能体用 `marvis kb` 读写知识库：fetch（scope/detail/start-block-id 等，照飞书）、page create/patch/move/delete、claims get/set/list、draft create/check/sync、page list、search（先接关键字）、get/list/create/update、raw、annotation、mr、history，以及 `marvis chat list/get --scope`。所有输出带 mention。

**Blocked by:** 01, 02

**Status:** ready-for-agent

- [x] 草稿接口：`/api/kb/drafts*`、`/api/kb/pages/{ref}/fetch`、ops、claims、check、sync（git 式冲突标记），乐观锁 version、stale_version、conflict_markers，按 spec 06 / 07.13
- [x] `kb draft create --job` 与 `POST /api/kb/drafts` 的 `job_id`：同事务写 `kb_job_draft`，404 / 403 / 409 `job_draft_exists`（决策 104）
- [x] 建草稿时从任务令牌记录 `kb_draft.task_id`（用于来源判定与溯源，成员调用为空，不在响应里返回）
- [x] CLI 命令与参数照 spec 08.1（四列参数表），`--output table|json`、`--full-id`、游标翻页
- [x] `kb draft create` 说明为「建一份草稿。一个变更请求对应一份草稿：从建草稿、提交，到按审核意见修改，读写都带同一个草稿 id；分几次改、改了几个页面，都写进这份草稿。」；所有 `--draft` 参数说明为「草稿 id（完整 UUID），`kb draft create` 输出的 `id`」（决策 104）
- [x] 格式检查规则（spec 04 LINT；不含 `reserved_page_changed`、`quickstart_not_updated`，决策 103）
- [x] `kb page list` 返回 `total`，支持可选 `--type` 在当前这一层过滤；`kb search` 关键词必填、`--type` 过滤、不翻页（决策 105）
- [x] chat list/get 的 scope 规则（spec 08.7）
- [x] CLI 单测（假服务端）、乐观锁并发测试、草稿 sync 冲突测试
- [x] 论断与页头 sources 的生成（claims set 后重算 sources、脚注校验），块的插入 / 删除 / 移动（票 01 只做了 ReplaceBlock）
- [x] 读取时把 `kb://页面id#块id` 改回路径（如票 02 还没做，用票 01 的 RewriteLinkDestinations）
