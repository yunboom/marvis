# 自动化模块改版：技术方案

> 设计稿：画布 https://claude.ai/artifact/DE45w1Gy41KhaKTk64jVkf （源文件 `design/project/`，与知识库设计稿同格式：canvas.json + 每个状态一张 .dc.html 画板）；`design/prototype.html` 是早期单页原型，以画布为准
> 参考：Claude 桌面端「例程」的列表、详情、运行对话三屏（版式与交互）
> 视觉：沿用 Marvis 设计稿画布（`~/Downloads/marvis-工作流设计稿源文件/画布全量`）——「09 自动化」的页头、Tab、工具栏，「24 改版」的国画状态色与浅灰头像，「46 改版」的侧栏，以及知识库「9.3 知识库作业」的对话页版式（72px 顶栏、52px 智能体栏、药丸输入框、右侧浅灰面板）
> 范围：web + desktop 共用的 `packages/views/autopilots/`；移动端不在本次范围

## 1. 结论

| 部分 | 改什么 | 后端 |
| --- | --- | --- |
| 列表页 | 表格 → 两列卡片；工具栏收成「范围分段 + 筛选图标 + 排序与显示图标 + 新建」 | 不改 |
| 详情页 | 单列长页 → 左「配置」/ 右「指令 + 运行记录」两栏；编辑、删除收进顶栏 | 不改 |
| 运行详情（仅运行） | 只读日志弹窗 → 整页多轮对话 | 第一轮照旧是自动化任务，第二轮起走聊天；1 个迁移 + 1 个接口 + 认领条件加一条 |

列表和详情只动外观与布局，功能逐项保留（见第 5 节对照清单）。多轮对话是唯一新增能力，按用户要求加入。

## 2. 列表页

文件：`autopilots-page.tsx`、`autopilot-list-toolbar.tsx`、`autopilot-list-actions.tsx`

- 头部：大标题「自动化」，下面一行是分段 Tab「自动化 / 任务唤醒」（替换现在的下划线 Tab），右侧放工具。
- 工具栏：范围（全部 / 启用 / 已暂停，带计数）改成分段按钮；「筛选」「排序与显示」改成两个图标按钮，菜单内容不变（筛选：执行者 / 模式 / 触发器 / 创建者；显示：排序字段、方向、列开关）。结果计数「n / 总数」保留在筛选激活时显示。
- 卡片：标题 + 暂停标记 → 两行指令摘要（`autopilot.description` 纯文本截断）→ 元信息行（状态 · 触发器 · 下次运行 · 上次运行 · 执行者 …）。
  - 原「列开关」改为控制元信息行显示哪些字段，store（`hiddenColumns`）和默认隐藏项不变。
  - 卡片整体是行链接（沿用 `useRowLink`，保留中键 / Cmd 点击新标签页）。
  - 悬停时右上角出现「…」行菜单。
- 去掉多选和批量操作（用户要求）：删除 `CheckboxCell`、`selectedIds` 和 `AutopilotBatchToolbar`，`DeleteAutopilotsDialog` 只保留单个删除的用法。
- 「新建自动化」改成下拉（用户要求）：第一项「从空白开始」，下面是「从模板创建」分组，列出 `TEMPLATES` 里的六个模板，点击打开预填好的 `AutopilotDialog`（复用现有 `openCreate(template)`）。有没有自动化都可用。
- 虚拟化：卡片按「行」虚拟化（一行 2 张，窄屏 1 张），`useVirtualizer` 的 `count = ceil(rows/列数)`，列数由容器宽度（`ResizeObserver`）算出；卡片定高（标题 + 两行摘要 + 元信息 ≈ 116px）以保持固定高度契约。
- 空状态：模板卡片与「从空白开始」保留，改成与列表同一套卡片样式。
- 任务唤醒 Tab：表格结构不动，只套用新头部。
- 删除不再使用的 `GRID_COLS`、`columnTrackVars`、`TABLE_HEAD_BAND` 和表头组件。

## 3. 详情页

文件：`autopilot-detail-page.tsx`

- 顶栏：面包屑「自动化 / 标题」；右侧 编辑（图标）、删除（图标，仍弹确认）、立即运行（主按钮，非启用状态禁用，运行中显示 loading）。
- 运行时缺失横幅（`pause_reason === "agent_runtime_required"`）原样保留在顶栏下。
- 左栏「配置」：
  - 状态：启停开关 + 状态标签 + 下次运行（取所有启用的时间表触发器里最早的 `next_run_at`）。开关从标题旁移到这里，`archived` 时禁用不变。
  - 属性两列：执行者、创建者、输出方式、项目（含加载中 / 无项目 / 不可用三态）。
  - 订阅者：仅 `create_issue` 模式显示。
  - 触发器：`TriggerRow` 内容不变（编辑时间表、删除、Webhook 地址复制、重置地址、已停用 / 已弃用徽标），样式改成浅灰底圆角块；「添加」入口改成区块标题右侧的文字按钮。
  - Webhook 投递：`WebhookDeliveriesSection` 不变，挪到左栏底部。
- 右栏：
  - 指令：`ReadonlyContent` 默认折叠约 5 行 + 渐隐，「显示全部 / 收起」。原来指令为空时不渲染，保持。
  - 运行记录：每行 = 状态图标 + 时间 + 摘要（已关联任务 / 失败原因）+ 来源 + 右箭头。
    - `run_only` 运行：点进运行对话页（取代 `TranscriptButton` 弹窗）。
    - `create_issue` 运行：点击跳任务详情，和现在一致（用户 2026-10-27 拍板，不开运行对话）。
    - 没派出任务的运行（跳过、派发前失败）没有会话，点进去只看运行信息，不显示输入框。
    - 跳过的运行仍折叠成一组。
- 危险区删除；删除按钮在顶栏，确认框文案不变。
- 窄屏（< 980px）两栏堆叠成一栏，顺序：状态 → 指令 → 运行记录 → 其余配置。

## 4. 运行对话页（新增能力：多轮对话）

目标：「仅运行」的每次运行都能多轮对话。做法：**第一轮（运行本身）照旧是自动化任务，第二轮起走聊天**。一次运行一个对话，能查看该自动化的人共用；运行中发的消息排队，运行结束后接着这次运行的会话继续。「创建任务」模式不变，运行记录点击仍跳任务详情。

为什么不让整个运行改走聊天：`CreateAutopilotTask` 换成 `SendDirectChatMessage` 会改变近十处行为（聊天建任务的 SQL 无 `autopilot_run_id`、归属变成人工发起、额外注入 composio、提示词和运行规则换成聊天的、统计与活动页按聊天算、工作目录不再即时回收、出现在聊天列表 / 未读 / 快捷动作、取消权限与优先级变化），回归面过大（2026-10-27 排查，见决策 15）。

### 4.1 现状（已核实）

- 运行结束时 `CompleteAgentTask / FailAgentTask` 把 `session_id / work_dir` 写回任务行。
- 聊天认领时读 `chat_session.session_id / work_dir`，运行时一致就续接（`handler/daemon.go:3644`）。
- 同一智能体、同一聊天会话已有任务在跑时，新任务不被认领（`pkg/db/queries/agent.sql:779`）。
- 用户消息挂着入队的任务（`service/task.go:2486`），任务上的 `initiator_user_id` 是发送人。
- 先例：知识库作业页把聊天嵌进业务页（`kb-job-page.tsx` + `use-kb-job-conversation.ts`），并在聊天列表里排除这些会话。

### 4.2 后端

- **数据**：`autopilot_run` 加 `chat_session_id UUID`（可空，软引用），配 `CREATE UNIQUE INDEX CONCURRENTLY`（单独一个迁移文件）。不加外键。迁移编号排在上游最大号之后，`*_rebrand_marvis` 仍排最后，同步改 `scripts/rebrand-marvis.py` 的 `KEEP`、`cmd/migrate/main.go` 并发索引表和引用文件名的测试。
- **获取或创建对话**：`POST /api/autopilots/{id}/runs/{runId}/chat`，返回 `{ chat_session_id }`。
  - 只接受 `run_only`（`create_issue` 返回 409 `run_mode_unsupported`），要求 `run.task_id` 不为空（否则 409 `run_has_no_session`）；运行中也可以创建。
  - 权限：能查看该自动化。
  - 事务内 `SELECT … FOR UPDATE` 锁 run 行，已有就返回；否则 `CreateChatSession`（agent = 运行任务的智能体，project = 自动化的项目，title = 自动化标题，creator = 第一个发消息的人），写回 `autopilot_run.chat_session_id`。
  - 运行任务已结束：用它的 `session_id / work_dir / runtime_id` 调 `UpdateChatSessionSession` 预填续接指针（任务因 `context_overflow` 等原因失败时只填 `work_dir`，过滤条件对齐 `GetLastTaskSession`）。
- **运行结束写指针**：运行任务结束时（`SyncRunFromTask` 所在的同步路径），若这次运行已有对话，把任务的 `session_id / work_dir / runtime_id` 写进对话指针。覆盖「运行中就建了对话」的情况。
- **运行中排队**：认领条件（`agent.sql:779` 的 `NOT EXISTS`）加一条：聊天任务所属会话挂在某次运行上、且该运行的任务仍在 `queued / dispatched / running / waiting_local_directory`，就先不认领。运行任务本身不挂 `chat_session_id`，提示词、归属、统计、回收等全部保持自动化原样。
- **共用访问**：`loadChatSessionForUser` 现在只放行创建者（`handler/chat.go:282`），会话挂在运行上时改为按「能查看该自动化」放行；每次发送仍按发送人做 `canInvokeAgent` 检查，追问产生的任务归属发送人。
- **发送人**：不加列；消息列表查询按 `task_id` 关联任务返回 `initiator_user_id` 作为 `sender_user_id`（可空，普通聊天前端回退到会话创建者）。
- **聊天侧排除**：`ListChatSessionsByCreator` 等加 `NOT EXISTS (SELECT 1 FROM autopilot_run r WHERE r.chat_session_id = cs.id)`；未读、FAB、快捷动作对这类会话的表现实现时核实，参照知识库作业的处理。
- **接口**：运行详情响应加 `chat_session_id`（可空），schema 加可选字段并补 malformed 响应测试。发消息、停止、拉消息用现有聊天接口。
- **清理**：删除自动化时一并归档这些会话。

### 4.3 前端

- 路由：`/{ws}/autopilots/{id}/runs/{runId}`。web 加 `apps/web/app/[workspaceSlug]/(dashboard)/autopilots/[id]/runs/[runId]/page.tsx`；desktop 在 `routes.tsx` 加同名路由；`useWorkspacePaths` 加 `autopilotRun(id, runId)`。
- 新组件 `packages/views/autopilots/components/autopilot-run-page.tsx`：
  - 顶部触发卡片（来源、时间、指令摘要）。
  - 第一轮：运行任务的执行过程，用 `taskMessagesOptions(run.task_id)` 渲染成一轮智能体回复（与现在的 `TranscriptButton` 同源，运行中实时刷新）。
  - 第二轮起：`useAutopilotRunConversation(sessionId)` 仿 `use-kb-job-conversation.ts`，组合 `ChatMessageList` + `ChatQueue` + `ChatInput`，与聊天页一致：发送中、停止、排队、重试、附件；用户消息显示发送人。
  - 第一次发送前调 `POST …/chat` 拿 `chat_session_id`，再发送。
  - 右侧面板：状态、来源、触发 / 完成时间、执行者、所属自动化、失败原因、Webhook 载荷（复用 `WebhookPayloadSlot`），以及一行「能查看这个自动化的成员共用这段对话。」。窄屏收起。
  - 离线 / 无权限：复用 `OfflineBanner`、`AgentAccessRevokedBanner`、`RuntimeRequiredBanner`。
  - `task_id` 为空的运行只显示运行信息，不显示输入框。
- 详情页运行记录：「仅运行」点进此页，「创建任务」仍跳任务详情；原 `RunRow` 里的 `TranscriptButton` 与 `syntheticTask` 删除。
- core：`AutopilotRun` schema 加 `chat_session_id`；聊天消息 schema 加可选 `sender_user_id`；`useEnsureAutopilotRunChat` mutation。

## 5. 现有功能对照清单

| 位置 | 现有功能 | 新位置 |
| --- | --- | --- |
| 列表 | 自动化 / 任务唤醒 Tab（URL `?tab=wakeups`） | 头部分段 Tab |
| 列表 | 新建自动化 / 新建唤醒 | 头部右侧主按钮（随 Tab 切换）；新建自动化改为下拉，含「从空白开始」和六个模板 |
| 列表 | 范围 全部 / 启用 / 已暂停 + 计数；过期 scope 回退「全部」 | 分段按钮 |
| 列表 | 筛选：执行者 / 模式 / 触发器 / 创建者，清除筛选 | 筛选图标菜单 |
| 列表 | 排序字段 + 方向；列头点击排序 | 排序与显示菜单（卡片无表头，列头排序并入菜单） |
| 列表 | 列显示开关（7 列） | 同一菜单的「卡片显示」字段开关 |
| 列表 | 暂停标记 + 运行时缺失提示 | 卡片标题旁图标 + title |
| 列表 | 上次运行状态点 + 相对时间 | 元信息行 |
| 列表 | 行点击 / 新标签页打开 | 卡片链接 + 行菜单 |
| 列表 | 行菜单：新标签页打开 / 暂停 / 恢复 / 删除 | 卡片「…」 |
| 列表 | 多选 + 全选 + 批量暂停 / 恢复 / 删除 | **去掉**（用户 2026-10-27 点名），单个暂停 / 启用 / 删除走「…」菜单 |
| 列表 | 加载骨架、错误重试、无匹配提示、空状态模板 | 保留，换成卡片骨架 |
| 详情 | 启停开关、状态文字 | 左栏「状态」 |
| 详情 | 编辑（弹窗）、立即运行（toast 分类逻辑不变） | 顶栏 |
| 详情 | 删除 + 确认 | 顶栏图标 + 确认 |
| 详情 | 运行时缺失横幅 + 绑定运行时链接 | 顶栏下 |
| 详情 | 执行者 / 创建者（悬停卡片）/ 输出方式 / 项目 / 订阅者 / 指令 | 左栏属性、右栏指令 |
| 详情 | 触发器：增删、编辑时间表、Webhook 复制 / 重置、徽标、下次运行 | 左栏触发器 |
| 详情 | Webhook 投递记录 | 左栏底部 |
| 详情 | 运行记录、跳过分组、跳任务 | 右栏 |
| 详情 | 查看执行日志（弹窗 + Webhook 载荷） | 运行对话页（执行过程 + 右侧载荷） |
| 详情 | 只读用户隐藏编辑 / 运行 / 删除 / 增删触发器 | 不变 |

新增：卡片上的两行指令摘要（已有字段，只是列表里首次展示）；运行对话页的续聊能力。

## 6. 实施顺序与校验

1. 列表页卡片化（纯前端）。
2. 详情页两栏（纯前端）。
3. 后端：迁移、获取或创建对话接口、运行结束写指针、认领条件、共用访问与发送人、聊天侧排除、删除清理 + 测试（DB 测试用 `testutil` fixture）。
4. 前端运行对话页 + web / desktop 路由 + core schema。
5. 校验：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`make test`；本地 `make up` 跑一次 run_only 自动化：运行期间两个账号先后发消息，确认消息排队到运行结束后才派发、带发送人、接着运行的会话和工作目录多轮对话；运行状态、统计、活动页与现在一致；create_issue 运行点击仍跳任务。

## 7. 风险

- **续接依赖同一 runtime**：智能体换过运行时，聊天现有逻辑会退回沿用工作目录。
- **工作目录回收**：隔了很久再追问时，daemon 可能已回收 `work_dir`；聊天现有逻辑如何处理待核实。
- **列表信息密度**：卡片一屏约 8 个，比表格少；自动化数量通常不多，可接受。
- **翻译**：新文案需同步 en / zh-Hans / zh-Hant / ja / ko / fr（`parity.test.ts` 会拦）。

## 8. 待确认

1. ~~卡片上展示两行指令摘要~~：已定加（2026-10-27）。
2. ~~续聊会话每人一个还是每次运行一个~~：已定一次运行共用一个对话（2026-10-27）。
3. ~~运行中能否追问~~：已定允许，消息进对话队列，运行结束后发出（2026-10-27）。
