# 02: 阅读：首页、页面树、阅读页、页面历史

**What to build:** 成员打开知识库首页（数据总览：知识库信息 + 待处理 + 最近变更，不显示页面正文，设计稿 2.x），在左侧页面树逐级展开（游标翻页，每页 200），打开页面阅读（块渲染、引用悬停含原始文件、目录、信息面板、草稿视图与多份草稿切换 3.9–3.10），查看页面历史与单次修改 diff（设计稿 7.x）。

**Blocked by:** 01

**Status:** ready-for-agent

- [x] `GET /api/kb/bases/{kb}/home`（带 quickstart 页面对象）、`GET /api/kb/bases/{kb}/pages`（cursor/limit/next_cursor、draft 叠加、draft_change）、页面读取、历史接口，按 spec 07 的契约
- [x] 阅读页、页面树、信息面板、目录面板、引用悬停、草稿条（含多份草稿下拉）组件在 packages/views，web 路由与 desktop 路由都接入
- [x] 接口测试 + 前端组件测试
- [ ] 决策 103：去掉首页 quickstart 正文与保留页（由票 03 一并完成）
