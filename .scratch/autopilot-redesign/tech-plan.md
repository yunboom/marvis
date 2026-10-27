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
| 运行详情（仅运行） | 只读日志弹窗 → 整页多轮对话 | 一次运行 = 一个聊天会话，指令作为第一条消息（照知识库作业）；1 个迁移 |

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

目标：「仅运行」的每次运行都能多轮对话。做法照知识库作业：**一次运行 = 一个聊天会话，指令作为第一条消息**。多轮对话、排队、续接会话、停止全部复用聊天现成能力。「创建任务」模式不变，运行记录点击仍跳任务详情。

### 4.1 先例：知识库作业

- 新建作业时建 `chat_session`（`handler/kb_job.go:550`），`kb_job.chat_session_id` 指向它。
- 第一条消息由服务端用模板拼好（`internal/kb/job.go` 的 `JobFirstMessage`），经 `SendDirectChatMessage` 发出（`kb_job.go:398`）；服务端写的部分和成员打的字之间用 `MemberMessageMarker` 分隔，页面只显示成员部分。
- 之后的多轮对话就是普通聊天。

### 4.2 后端

- **派发改成发聊天**：`dispatchRunOnly`（`service/autopilot.go`）里准入检查（额度、运行时、权限等）原样保留，只把「`CreateAutopilotTask` 入队」这一步换成：
  1. 建 `chat_session`（agent = 执行智能体，project = 自动化的项目，title = 自动化标题，creator = 本次运行的负责人：手动触发是点击的人，定时 / Webhook 是规则负责人）。
  2. 用模板拼第一条消息：触发来源、Webhook 载荷、自动化指令（内容同现在 `buildAutopilotPrompt` 里的这几项），经 `SendDirectChatMessage` 发出。
  3. 入队的任务带上 `autopilot_run_id`，`SyncRunFromTask`（`service/autopilot.go:1194`，按 `task.AutopilotRunID` 同步）照常更新运行状态；`run.task_id`、`autopilot_run.chat_session_id` 指向这次的任务和会话。
- **数据**：`autopilot_run` 加 `chat_session_id UUID`（可空，软引用），配 `CREATE UNIQUE INDEX CONCURRENTLY`（单独一个迁移文件）。不加外键。迁移编号排在上游最大号之后，`*_rebrand_marvis` 仍排最后，同步改 `scripts/rebrand-marvis.py` 的 `KEEP`、`cmd/migrate/main.go` 并发索引表和引用文件名的测试。
- **聊天列表排除**：`ListChatSessionsByCreator` 等加 `NOT EXISTS (SELECT 1 FROM autopilot_run r WHERE r.chat_session_id = cs.id)`，这些会话不出现在「我的对话」。
- **共用访问**：一次运行一个对话，能查看该自动化的人都能看、都能发。`loadChatSessionForUser` 现在只放行创建者（`handler/chat.go:282`），会话挂在运行上时改为按「能查看该自动化」放行；每次发送仍按发送人做 `canInvokeAgent` 检查。
- **发送人**：不加列。用户消息挂着入队的任务（`service/task.go:2486`），任务上的 `initiator_user_id` 就是发送人；消息列表查询按 `task_id` 关联返回 `sender_user_id`（可空，普通聊天前端回退到会话创建者）。
- **运行中发消息**：同一会话有任务在跑时新消息自动排队（`pkg/db/queries/agent.sql:779`），不需要额外处理。
- **接口**：运行详情响应加 `chat_session_id`（可空），schema 加可选字段并补 malformed 响应测试。发消息、停止、拉消息全部用现有聊天接口。
- **清理**：删除自动化时一并归档这些会话。
- **实现时核实**：
  - 自动化专属的运行时规则（brief 里的自动化工作流段、`AutopilotIssueCommandsGuard`）在聊天任务上是否仍生效；不生效就把需要的规则写进第一条消息模板。
  - 旧运行（改造前的 run_only）没有会话：页面只显示执行记录，不显示输入框。

### 4.3 前端

- 路由：`/{ws}/autopilots/{id}/runs/{runId}`。web 加 `apps/web/app/[workspaceSlug]/(dashboard)/autopilots/[id]/runs/[runId]/page.tsx`；desktop 在 `routes.tsx` 加同名路由；`useWorkspacePaths` 加 `autopilotRun(id, runId)`。
- 新组件 `packages/views/autopilots/components/autopilot-run-page.tsx`，照抄知识库作业页：
  - `useAutopilotRunConversation(sessionId)` 仿 `use-kb-job-conversation.ts`，组合 `ChatMessageList` + `ChatQueue` + `ChatInput`，与聊天页一致：发送中、停止、排队、重试、附件。
  - 第一条（服务端拼的）消息不按普通气泡显示，渲染成顶部的「触发卡片」（来源、时间、指令摘要）。
  - 用户消息显示发送人。
  - 右侧面板：状态、来源、触发 / 完成时间、执行者、所属自动化、失败原因、Webhook 载荷，以及一行「能查看这个自动化的成员共用这段对话。」。窄屏收起。
  - 离线 / 无权限：复用 `OfflineBanner`、`AgentAccessRevokedBanner`、`RuntimeRequiredBanner`。
- 详情页运行记录：「仅运行」点进此页，「创建任务」仍跳任务详情；原 `RunRow` 里的 `TranscriptButton` 与 `syntheticTask` 删除。
- core：`AutopilotRun` schema 加 `chat_session_id`；聊天消息 schema 加可选 `sender_user_id`。

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
3. 后端：派发改为「建会话 + 发第一条消息」、迁移、聊天列表排除、共用访问与发送人、删除清理 + 测试（DB 测试用 `testutil` fixture）。
4. 前端运行对话页 + web / desktop 路由 + core schema。
5. 校验：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`make test`；本地 `make up` 跑一次 run_only 自动化：运行状态正常同步；运行中用两个账号先后发消息，确认排队顺序执行、消息带发送人、接着同一会话多轮对话；create_issue 运行点击仍跳任务。

## 7. 风险

- **续接依赖同一 runtime**：智能体换过运行时，聊天现有逻辑会退回沿用工作目录。
- **工作目录回收**：隔了很久再追问时，daemon 可能已回收 `work_dir`；聊天现有逻辑如何处理待核实。
- **列表信息密度**：卡片一屏约 8 个，比表格少；自动化数量通常不多，可接受。
- **翻译**：新文案需同步 en / zh-Hans / zh-Hant / ja / ko / fr（`parity.test.ts` 会拦）。

## 8. 待确认

1. ~~卡片上展示两行指令摘要~~：已定加（2026-10-27）。
2. ~~续聊会话每人一个还是每次运行一个~~：已定一次运行共用一个对话（2026-10-27）。
3. ~~运行中能否追问~~：已定允许，消息进对话队列，运行结束后发出（2026-10-27）。
