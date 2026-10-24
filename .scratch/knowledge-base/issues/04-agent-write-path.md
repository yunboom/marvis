# 04: 智能体写入路径——clone、推分支、建变更请求

**What to build:** 智能体用 `marvis kb clone` 把工作区知识库仓库拉到本地，修改后 `marvis kb change create` 推送 `kb/*` 分支并创建变更请求，立刻拿到冲突文件；`change update` 更新同一个变更请求，`change get --comments` 读审核意见，`change list` 列出。主线不能被直接推送。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] git smart HTTP，沿用 API 鉴权
- [ ] pre-receive 只允许 `refs/heads/kb/*`
- [ ] 变更请求创建 / 更新 API，冲突检测（merge-tree）
- [ ] CLI clone / change create / update / get / list
- [ ] 仓库层与 handler 测试
