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
| 运行详情 | 只读日志弹窗 → 整页对话，可继续和智能体聊 | **新增 1 个接口 + 1 个迁移** |

列表和详情只动外观与布局，功能逐项保留（见第 5 节对照清单）。运行续聊是唯一新增能力，按用户要求加入。

## 2. 列表页

文件：`autopilots-page.tsx`、`autopilot-list-toolbar.tsx`、`autopilot-list-actions.tsx`

- 头部：大标题「自动化」，下面一行是分段 Tab「自动化 / 任务唤醒」（替换现在的下划线 Tab），右侧放工具。
- 工具栏：范围（全部 / 启用 / 已暂停，带计数）改成分段按钮；「筛选」「排序与显示」改成两个图标按钮，菜单内容不变（筛选：执行者 / 模式 / 触发器 / 创建者；显示：排序字段、方向、列开关）。结果计数「n / 总数」保留在筛选激活时显示。
- 卡片：标题 + 暂停标记 → 两行指令摘要（`autopilot.description` 纯文本截断）→ 元信息行（状态 · 触发器 · 下次运行 · 上次运行 · 执行者 …）。
  - 原「列开关」改为控制元信息行显示哪些字段，store（`hiddenColumns`）和默认隐藏项不变。
  - 卡片整体是行链接（沿用 `useRowLink`，保留中键 / Cmd 点击新标签页）。
  - 悬停时右上角出现勾选框和「…」行菜单；勾选态卡片常显。批量栏 `AutopilotBatchToolbar` 不变。
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
    - `create_issue` 运行：点击跳任务详情（不变）。
    - `run_only` 运行：点击进入新的运行对话页（取代 `TranscriptButton` 弹窗）。
    - 跳过的运行仍折叠成一组。
- 危险区删除；删除按钮在顶栏，确认框文案不变。
- 窄屏（< 980px）两栏堆叠成一栏，顺序：状态 → 指令 → 运行记录 → 其余配置。

## 4. 运行对话页（新增能力）

### 4.1 现状

- `run_only` 运行入队时（`service/autopilot.go` 的 `dispatchRunOnly` → `CreateAutopilotTask`）不带 `session_id / work_dir / chat_session_id`，daemon 认领时也没有 resume 分支，每次运行都是全新会话。
- 运行结束后，`CompleteAgentTask / FailAgentTask` 会把 `session_id / work_dir` 写回 task 行，因此**一次运行跑完，就有可以 resume 的会话**。
- 聊天发消息时，daemon 认领聊天 task 会读 `chat_session.session_id / work_dir`；只有 `runtime_id` 一致才 resume（`handler/daemon.go:3644`），否则退回最近一条带 session 的聊天 task。
- 已有「把聊天嵌进业务页」的先例：知识库 job（`kb_job.chat_session_id` + `kb-job-page.tsx` + `use-kb-job-conversation.ts`），并在聊天列表里用 `NOT EXISTS` 排除这些会话。
- `create_issue` 运行产出的是任务，在任务里评论 / @ 智能体已经能续上会话（按 `(agent_id, issue_id)` resume），不需要新能力。

### 4.2 方案：运行 ↔ 聊天会话，懒创建

**数据**

- 新迁移：新表 `autopilot_run_chat(run_id, user_id, chat_session_id, created_at)`，主键 `(run_id, user_id)`，`chat_session_id` 唯一索引（`CREATE UNIQUE INDEX CONCURRENTLY`，单独一个迁移文件）。不加外键。
  - 为什么按人分会话：`chat_session` 只属于创建者（`gatePublicChatSessionForUser`），多人看同一次运行时各聊各的，互不干扰。
  - 迁移编号：当前最大是 `633_rebrand_marvis`，按仓库规则 rebrand 排最后：新迁移用 633/634，rebrand 顺延到 635，同步改 `scripts/rebrand-marvis.py` 的 `KEEP`、`cmd/migrate/main.go` 并发索引表和引用文件名的测试。
- 聊天列表查询（`ListChatSessionsByCreator` 等）加 `NOT EXISTS (SELECT 1 FROM autopilot_run_chat r WHERE r.chat_session_id = cs.id)`，这些会话不出现在「我的对话」里。

**接口**

- `POST /api/autopilots/{id}/runs/{runId}/chat`：获取或创建当前用户在这次运行上的会话，返回 `{ chat_session_id }`。
  - 只接受 `run_only` 且 task 已结束（completed / failed）的运行；运行中返回 409 `run_in_progress`，前端在运行结束前不建会话。
  - 权限：调用者对该自动化有读权限，且 `canInvokeAgent` 通过（与聊天发送一致）。
  - 事务内 `SELECT … FOR UPDATE` 锁 run 行，已存在直接返回；否则 `CreateChatSession`（agent = task.agent_id，project = autopilot.project_id，title = 自动化标题，creator = 当前用户），再用原 task 的 `session_id / work_dir / runtime_id` 调 `UpdateChatSessionSession` 预填 resume 指针，最后写 `autopilot_run_chat`。
  - 原 task 因 `context_overflow` 等不适合 resume 的原因失败时不预填 session（过滤条件对齐 `GetLastTaskSession`），只预填 `work_dir`。
- 发消息、停止、排队直接复用 `POST /api/chat/sessions/{id}/messages` 等现有聊天接口，daemon claim 逻辑不改。
- `GET /api/autopilots/{id}/runs/{runId}` 响应增加 `chat_session_id`（当前用户的，可空），schema 加可选字段 + 默认 `null`，补 malformed 响应测试。

**上下文兜底**：runtime 换过或 session 文件已丢失时 resume 失败。第一条用户消息由服务端拼一段前置说明（自动化标题、指令摘要、本次运行结果摘要 `task.result` 截断），保证新会话也知道在聊哪次运行。拼接放在创建会话的接口里，以「服务端写入部分」的方式存（同知识库 job 的做法：用户只看到自己打的字）。

**清理**：删除自动化时，`DeleteAutopilot` 事务里一并软删 / 归档关联的 chat_session 并删 `autopilot_run_chat` 行。

**归属**：续聊的 task 归属是发消息的人（direct_human），不是自动化的规则负责人。运行对话页输入框下方写明「与 xx 对话」，不额外解释。

### 4.3 前端

- 路由：`/{ws}/autopilots/{id}/runs/{runId}`。web 加 `apps/web/app/[workspaceSlug]/(dashboard)/autopilots/[id]/runs/[runId]/page.tsx`；desktop 在 `routes.tsx` 加同名路由；`useWorkspacePaths` 加 `autopilotRun(id, runId)`。
- 新组件 `packages/views/autopilots/components/autopilot-run-page.tsx`：
  - 顶栏：面包屑「自动化 / 标题 / 运行时间」+ 状态标签 + 运行信息面板开关。
  - 消息区第一块是「触发卡片」（来源 + 时间 + 指令摘要），第二块是原 task 的执行过程，用 `taskMessagesOptions(taskId)` 渲染成一轮智能体回复（与 `TranscriptButton` 同源，运行中实时刷新）。
  - 后续消息：照抄 `useKbJobConversation` 写 `useAutopilotRunConversation(sessionId)`，组合 `ChatMessageList` + `ChatQueue` + `ChatInput`（`draftKeyOverride` 隔离草稿），与聊天页行为一致：发送中、停止、排队、重试、附件。
  - 会话懒创建：第一次发送前调 `POST …/chat` 拿 `chat_session_id`，再发送。运行未结束时允许打字，消息先进前端排队，运行结束后自动建会话并发出。
  - 右侧面板：状态、来源、触发 / 完成时间、执行者、失败原因、Webhook 载荷（复用 `WebhookPayloadSlot`）、返回自动化链接。窄屏收起。
  - 离线 / 无权限：复用 `OfflineBanner`、`AgentAccessRevokedBanner`、`RuntimeRequiredBanner`。
- `create_issue` 运行不进此页，行点击仍跳任务详情。
- 原 `RunRow` 里的 `TranscriptButton` 与 `syntheticTask` 构造删除。
- core：`autopilotRunChatOptions` / `useEnsureAutopilotRunChat` mutation，`AutopilotRun` schema 加 `chat_session_id`。

## 5. 现有功能对照清单

| 位置 | 现有功能 | 新位置 |
| --- | --- | --- |
| 列表 | 自动化 / 任务唤醒 Tab（URL `?tab=wakeups`） | 头部分段 Tab |
| 列表 | 新建自动化 / 新建唤醒 | 头部右侧主按钮（随 Tab 切换） |
| 列表 | 范围 全部 / 启用 / 已暂停 + 计数；过期 scope 回退「全部」 | 分段按钮 |
| 列表 | 筛选：执行者 / 模式 / 触发器 / 创建者，清除筛选 | 筛选图标菜单 |
| 列表 | 排序字段 + 方向；列头点击排序 | 排序与显示菜单（卡片无表头，列头排序并入菜单） |
| 列表 | 列显示开关（7 列） | 同一菜单的「卡片显示」字段开关 |
| 列表 | 暂停标记 + 运行时缺失提示 | 卡片标题旁图标 + title |
| 列表 | 上次运行状态点 + 相对时间 | 元信息行 |
| 列表 | 行点击 / 新标签页打开 | 卡片链接 + 行菜单 |
| 列表 | 行菜单：新标签页打开 / 暂停 / 恢复 / 删除 | 卡片「…」 |
| 列表 | 多选 + 全选 + 批量暂停 / 恢复 / 删除 | 卡片勾选 + 批量栏；**全选**放进批量栏（无表头后的新位置） |
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
3. 后端：迁移 + 获取或创建会话接口 + 聊天列表排除 + 删除清理 + 测试（DB 测试用 `testutil` fixture）。
4. 前端运行对话页 + web / desktop 路由 + core schema。
5. 校验：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`make test`；本地 `make up` 跑一次 run_only 自动化，在运行页追问，确认 resume 到同一工作目录。

## 7. 风险

- **resume 依赖同一 runtime**：智能体换过运行时则只继承工作目录或全新开始，靠第 4.2 的前置说明兜底。
- **工作目录回收**：daemon 可能已回收 `work_dir`；需要确认 GC 策略，必要时改用 `durable_work_dir`（待核实）。
- **列表信息密度**：卡片一屏约 8 个，比表格少；自动化数量通常不多，可接受。
- **翻译**：新文案需同步 en / zh-Hans / zh-Hant / ja / ko / fr（`parity.test.ts` 会拦）。

## 8. 待确认

1. 卡片上展示两行指令摘要，可以吗？（列表原来不显示指令）
2. 续聊会话按「每人一个」还是「每次运行一个、只允许负责人聊」？方案默认每人一个。
3. 运行中能否追问？方案默认：可以打字排队，运行结束后自动发出；不打断正在执行的运行。
