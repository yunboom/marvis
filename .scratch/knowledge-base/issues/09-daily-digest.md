# 09: 每日知识沉淀

**What to build:** owner/admin 配置每日知识沉淀（执行者、时间、时区）并启用；它在自动化列表里带锁标，不能删除，没有知识库时不能启用。每次运行由智能体调用 `marvis kb sources` 分页获取上次运行以来的任务、评论和运行时主人自己的对话，产出一个变更请求。CLI `kb digest get/update/enable/disable/run`、`kb sources`。

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] autopilot `system_key`，删除拒绝、无库拒绝启用、删光知识库自动停用
- [ ] 配置 API（按需创建）、立即运行
- [ ] sources 分页（60% 窗口、最多 10 页、截断标记）与对话范围
- [ ] 自动化列表与详情 UI、知识库页入口
- [ ] 测试
