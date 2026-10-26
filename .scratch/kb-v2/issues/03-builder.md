# 03: 构建器：对话创建与配置知识库

**What to build:** 成员通过对话创建知识库、修改目标和 Schema（设计稿 1.2–1.3、1.5–1.10、10.x），照创建智能体的构建器做：隐藏构建器智能体、`<kb_draft>` 回填右侧、未完成的创建横幅、放弃确认、运行时更换、默认 / 自定义 Schema、放大编辑。创建后跳到知识库作业并显示上手引导。

**Blocked by:** 01

**Status:** ready-for-agent

- [x] `/api/kb/builder/sessions*`、`POST /api/kb/bases`（slug 必填、schema_mode）、`PATCH /api/kb/bases/{kb}`、配置修订，按 spec 07.1 / 07.x
- [x] 默认 Schema、目标模板、构建器指令（英文原文）落成常量
- [x] 前端复用 builder-conversation 组件；web / desktop 都接入
- [x] 复用创建智能体的测试方式
