# 会话来源 chat_session.source 决策记录

## 问题

会话是否出现在聊天界面原来有两套表达：

- 智能体创建、知识库创建会话的对方是隐藏的系统智能体，靠智能体可见性（`kind = 'user'`）间接隐藏。
- 知识库任务的对话、自动化运行的追问由用户自己的智能体执行，只能在每条查询里写 `NOT EXISTS (SELECT 1 FROM kb_job ...)` / `NOT EXISTS (SELECT 1 FROM autopilot_run ...)` 排除，已有查询漏写：运行中指示漏了知识库任务，工作区聊天列表两种都没排除。

## 决策

1. **（2026-10-28，用户）** 把「谁执行」和「在哪里展示」分开：执行者不变（知识库任务和运行追问仍由用户选的智能体执行），展示位置由会话上的 `source` 决定。
2. **（2026-10-28，用户）** 运行追问可以被知识库收录；知识库任务自己的对话和两种创建会话不收录。
3. **（2026-10-28，用户）** 智能体可见性过滤保留，它同时服务智能体列表。
4. **（2026-10-28，实现）** 不加索引：新条件都跟在已有的 `workspace_id` / `creator_id` / 任务队列条件后面，只在已选出的少量行上判断。
5. **（2026-10-28，实现）** `CreateChatSession` 的 `Source` 是必填参数，每个建会话路径显式写值；漏写会被 CHECK 约束拦下，而不是静默落成 `chat`。
6. **（2026-10-28，实现）** CLAUDE.md 里决策八已被「路径前缀部署」占用，本决策记为决策九。

## 取值

| 值 | 含义 | 写入路径 |
| --- | --- | --- |
| `chat` | 普通聊天，含 Mika 开局和外部渠道聊天 | 聊天窗口新建、Mika、渠道引擎（两处），列默认值 |
| `kb_job` | 知识库任务的对话 | `createKbJobRows`（`kb_job.go`） |
| `autopilot_run` | 自动化运行的追问 | `ensureAutopilotRunChatSession`（`autopilot_run_chat.go`） |
| `kb_builder` | 知识库创建 / 配置会话 | `CreateKbBuilderSession`（`kb_builder.go`） |
| `agent_builder` | 智能体创建会话 | `CreateAgentBuilderSession`（`agent_builder.go`） |

迁移 `650_chat_session_source` 加列（默认 `chat`）和 CHECK 约束，按顺序回填：被 `kb_job.chat_session_id` 引用 → `kb_job`；被 `autopilot_run.chat_session_id` 引用 → `autopilot_run`；有 `kb_builder_session` 行 → `kb_builder`；有 `agent_builder_draft` 行或对方是 `system_key LIKE 'agent_builder:%'` 的系统智能体 → `agent_builder`；其余 `chat`。改名迁移顺延为 `651_rebrand_marvis`。

## 查询改动

| 查询 | 用途 | 改前 | 改后 |
| --- | --- | --- | --- |
| `ListChatSessionsByCreator` | 聊天列表 | 排除 kb_job、autopilot_run | `source = chat` |
| `ListAllChatSessionsByCreator` | 聊天列表（含归档）、未读 | 排除 kb_job、autopilot_run | `source = chat` |
| `ListPendingChatTasksByCreator` | 运行中任务列表 | 只排除 autopilot_run | `source = chat` |
| `HasPendingChatTasksByCreator` | 运行中指示 | 只排除 autopilot_run（知识库任务会点亮） | `source = chat` |
| `GetOldestActiveChatSessionForCreatorAgent` | Mika 会话查找 | 不过滤 | `source = chat` |
| `ListKbWorkspaceChatSessions` | `marvis chat list --scope workspace` | 不排除；预览只滤 `channel_command` | `source = chat`；预览也滤 `instruction` |
| `ListKbSources` 聊天分支 | 可收录的聊天 | 只排除 kb_job | `source IN (chat, autopilot_run)` |
| `ListChatDraftRestoresBySession` / `DeleteChatDraftRestore` | 草稿恢复 | `NOT EXISTS autopilot_run` 判断共享会话 | 关联会话，`source <> autopilot_run`，行为不变 |
| `CreateChatSession` | 建会话 | 无来源 | 必填 `source` |

未改：`ListAgentBuilderSessionsByCreator`、`ListKbBuilderSessionsByCreator`（各自页面的列表，按系统智能体 / `kb_builder_session` 取）、`ListKbOwnChatSessionIDs`（只校验给定 id 的归属）。守卫测试 `chat_session_source_guard_test.go` 要求聊天界面查询按 `source` 过滤，新增按创建人读会话的查询要么过滤 `source`，要么登记理由。
