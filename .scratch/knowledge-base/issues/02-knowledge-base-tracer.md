# 02: 知识库主干——建库、内置 schema、侧栏入口

**What to build:** 成员在侧栏 Skills 上方点「知识库」，看到工作区的知识库（新工作区自带「团队知识库」），可以切换、新建（名称、描述、维护智能体）、修改；owner/admin 可以删除并看到影响。每个知识库是工作区仓库里的一个目录，带内置 schema。CLI 能 list / get / create / update，没有 delete。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 工作区仓库初始化、内置 schema 写入、按目录建库与删除（删除是一次 commit）
- [ ] 新建工作区自动生成「团队知识库」
- [ ] 知识库 CRUD API 与权限（删除仅 owner/admin，修改为 owner/admin 或创建者）
- [ ] 删除时一并关闭该库的批注与变更请求
- [ ] web 与 desktop 路由、侧栏入口、空状态、库切换、新建弹窗、设置标签
- [ ] `marvis kb list/get/create/update`
- [ ] handler 测试与 schema 畸形响应测试
