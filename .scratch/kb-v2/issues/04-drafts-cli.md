# 04: 草稿读写与 marvis kb CLI

**What to build:** 智能体用 `marvis kb` 读写知识库：fetch（scope/detail/start-block-id 等，照飞书）、page create/patch/move/delete、claims get/set/list、draft create/check/sync、page list、search（先接关键字）、get/list/create/update、raw、annotation、mr、history，以及 `marvis chat list/get --scope`。所有输出带 mention。

**Blocked by:** 01, 02

**Status:** ready-for-agent

- [ ] 草稿接口：`/api/kb/drafts*`、`/api/kb/pages/{ref}/fetch`、ops、claims、check、sync（git 式冲突标记），乐观锁 version、stale_version、conflict_markers，按 spec 06 / 07.13
- [ ] CLI 命令与参数照 spec 08.1（四列参数表），`--output table|json`、`--full-id`、游标翻页
- [ ] 格式检查规则（spec 04 LINT）
- [ ] chat list/get 的 scope 规则（spec 08.7）
- [ ] CLI 单测（假服务端）、乐观锁并发测试、草稿 sync 冲突测试
- [ ] 论断与页头 sources 的生成（claims set 后重算 sources、脚注校验），块的插入 / 删除 / 移动（票 01 只做了 ReplaceBlock）
- [ ] 读取时把 `kb://页面id#块id` 改回路径（如票 02 还没做，用票 01 的 RewriteLinkDestinations）
