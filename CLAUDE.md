@AGENTS.md

# Fork 说明：Marvis（同步上游前必读）

本仓库 fork 自 `multica-ai/multica`，在其基础上做了品牌改名和视觉改造。以下决策会影响每次同步上游，合并时按此处理。

## 远程

- `origin` = `git@github.com:yunboom/marvis.git`（本 fork，https://github.com/yunboom/marvis ，提交和推送到这里）
- `upstream` = `https://github.com/multica-ai/multica.git`（上游，只拉取）

## 决策一：品牌全量改名 Multica → Marvis

- 范围是全部被 git 跟踪的文本和路径：代码标识符、注释、文案、文档、CLI 命令（`marvis`）、Go module（`github.com/yunboom/marvis/server`）、npm scope（`@marvis/*`）、环境变量（`MARVIS_*`）、docker compose 项目名、外部域名（`multica.ai` → `marvis.ai`）。本地项目目录也叫 `marvis`。
- 仓库地址指向本 fork：主仓库 `multica-ai/multica` → `yunboom/marvis`（clone / issue / release / raw 安装脚本 / Releases API），本仓库 CI 发布的 ghcr 镜像与 Helm chart、Homebrew tap、桌面端更新源、release 工作流的 owner 判断都改为 `yunboom`。上游的其他仓库（`marvis-cli`、`dsh-marvis-runtime`）、npm 包 `@marvis-ai/*` 和测试夹具里的仓库名保持改名后的 `marvis-ai`，它们在 yunboom 下不存在。
- 规则：大小写保持替换（`multica`/`Multica`/`MULTICA` → `marvis`/`Marvis`/`MARVIS`），`multicast` 不替换。
- 改名由 `scripts/rebrand-marvis.py` 完成，脚本幂等，只保留以下文件里的旧名：脚本本身、本文件、`server/migrations/651_rebrand_marvis.*.sql`。新增必须保留旧名的文件时，同步加进脚本的 `KEEP`。
- `marvis.ai` 等域名需自行持有，否则对应链接失效。

## 决策一补充：机器级标识统一用 marvis（2026-10-23 撤回 marvis-studio）

家目录 `~/.marvis`、桌面端深链 `marvis://`、桌面端打包名 / userData / WM_CLASS `Marvis`，与品牌名一致。

- 曾因本机腾讯 Marvis.app 占用 `~/.marvis`、`marvis://`、`/Applications/Marvis.app` 而改用 marvis-studio，后决定不再规避：与腾讯 Marvis 同机安装时，深链可能被它接管、`~/.marvis` 会写进它的数据目录，需先卸载腾讯 Marvis。
- `scripts/rebrand-marvis.py` 不再有 `STUDIO_RULES`，上游同步后只跑改名和 `FORK_RULES`。

## 决策二：视觉与交互照搬 Marvis.app

- 设计 token（`packages/ui/styles/tokens.css`）：纯中性灰阶、`#f7f7f7` 外壳、`#0f0f0f` 主色、`#7b4835` 品牌色、`0.75rem` 基础圆角、Marvis 阴影；颜色写成等价的 `oklch()`（UI Lab 只认这种格式）。
- 圆角（`tokens.css` 的 `--radius-*`）：除 `xs`…`4xl` 阶梯外，Marvis 的角色圆角是固定值：头像 `avatar` 28%、小卡片与图标块 `tile` 10px、看板泳道 `lane` 16px、大面板 `pane` 20px、输入框外壳 `composer` 22px、单行聊天输入框 `composer-pill` 26px、行 `row` 8px、弹窗 `dialog` 20px。新代码用这些名字，不写任意值；`scripts/check-ui-radius-tokens.mjs` 会拦，新增角色要同步登记到 `packages/ui/lib/utils.ts` 的 tailwind-merge 配置。
- 偏离 Marvis 的地方：次要文字 `--muted-foreground` 用 `#666`、`--faint-foreground` 用 `#888`（Marvis 原值 45% 黑达不到 WCAG AA，`apps/web/app/text-contrast.test.ts` 会拦）；hover/selected 等填充色用不透明等效值（sticky 表头不能透出内容）。
- 动效（`packages/ui/styles/base.css`）：菜单 `menu-unfold`（scaleY .8→1，150ms ease-out）、弹层 `popover-pop-in`（scale .92→1）、弹窗 50ms 纯淡入、Tooltip 200ms 淡入、logo `logo-intro`、`spring-rise`。
- 共享组件（`packages/ui/components/ui/` 下 button、dialog、alert-dialog、sheet、dropdown-menu、context-menu、select、popover、hover-card、tooltip、input、textarea、tabs、sidebar）：药丸按钮、填充式输入框、36px 菜单项、分段式 Tabs。
- 字体栈 PingFang SC / Noto Sans SC 优先（`apps/web/app/globals.css`、`apps/desktop/src/renderer/src/globals.css`）。
- Logo：`packages/ui/components/common/marvis-icon.tsx`（圆角方块 + 镂空 "M"），docs 站、移动端、favicon、桌面/PWA/移动端图标已同步；应用侧栏顶部显示 logo + "Marvis" 字标（`marvis-wordmark.tsx`，Marvis.app 的 SVG 字标）；侧栏默认宽 216px。
- 状态与优先级色（`tokens.css` 的 `--status-*`、`--priority-*`）：状态用国画颜料（淡墨、藤黄、花青、石绿、朱砂），优先级是小圆点（紧急 / 高 / 中实心，低空心，无优先级是低的空心圈加斜线；创建任务工具栏的 ghost 药丸里放大到与状态圈同大）；浅色值对白底和 `#f7f7f7` 都要保持 3:1。自定义状态 / 标签色板是 `color-picker.tsx` 的 10 色国画色板。
- 侧栏（`app-sidebar.tsx`）：新建任务是 logo 行右侧的加号按钮，不占导航行；收件箱不在导航里，改名「消息」，入口是工作区行右侧的铃铛（当前工作区有未读时显示红点），点开是 `MessageBox` 弹窗（`inbox/components/message-box.tsx`，内容就是 `InboxPage surface="dialog"`，选中项不写 URL）；`/inbox` 路由和 `?issue=` 深链保留为完整页面；「聊天」中文叫「我的对话」；工作区头像是黑底白字圆角方块（`workspace-avatar.tsx`）。同步上游时侧栏和 `inbox-page.tsx` 易冲突：保留这套入口，合入上游新增的行为。
- 头像统一浅灰底黑字，成员圆形、智能体和小队圆角方形（`actor-avatar.tsx`）；智能体运行用绿色呼吸灯（`breathing-dot.tsx`、`base.css` 的 `animate-breathe`）。
- 看板按状态分组时是四列泳道（未开始 / 工作中 / 需介入 / 已结束，按 `status_group` 分列，见决策六；`board-status-columns.ts`、`status-lane-board.tsx`）；泳道视图同样是这四列，每个格子直接渲染看板的 `StatusLane`，只是多了按负责人 / 项目 / 父任务分行（`swimlane-view.tsx`）；新建任务弹窗用「手动创建 / 智能体创建」标签和墨色 `BorderBeam variant="ink"`。同步上游时这些文件冲突，保留本 fork 的样式，只合入上游新增的行为。

## 决策三：飞书登录（fork 独有）

- 国内飞书网页 OAuth 登录 + 飞书客户端内免登，按邮箱匹配账号，与 Google 登录同构。
- 服务端：`server/internal/handler/auth_lark.go`（`POST /auth/lark`，路由在 `cmd/server/router.go`）；`auth.go` 的 GoogleLogin 尾段抽成 `completeOAuthLogin` 两者共用；`config.go` 下发 `lark_login_app_id`。
- 环境变量：`MARVIS_LARK_LOGIN_APP_ID`、`MARVIS_LARK_LOGIN_APP_SECRET`、`MARVIS_LARK_LOGIN_TENANT_KEYS`（`.env.example`、`docker-compose.selfhost.yml`）。
- 前端：`packages/views/auth/login-page.tsx`（飞书按钮、`lark` / `onLarkLogin`）、`use-lark-client-login.ts`（客户端免登）、`apps/web/app/(auth)/login/page.tsx`、`apps/web/app/auth/callback/page.tsx`（state 带 `provider:lark` 时走飞书）、`callback-error.ts`、桌面端 `pages/login.tsx`、core 的 `larkLogin` / `loginWithLark` / `larkLoginAppId`、auth 语言包。
- 同步上游时 `auth.go`、`login-page.tsx`、`callback/page.tsx` 易冲突：保留上游改动后重新接回飞书分支，并跑 `Lark|Google` 相关测试。

## 决策四：后端默认端口 13840

后端（API 服务）默认端口是 13840，不用上游的 8080，避免与本机其他服务冲突。

- 范围：服务端 `PORT` 缺省值、CLI `setup self-host --port` 与各处默认服务器地址、daemon 默认 `ws://localhost:13840/ws`、`Makefile`、`scripts/`、`.env.example`、`Dockerfile`（EXPOSE）、`docker-compose.selfhost.yml`（宿主机端口缺省值、容器内端口、`PORT`、`REMOTE_API_URL`）、Helm chart、release 工作流、web / desktop / core / views 的默认地址、e2e、文档与测试夹具。
- 不改的 8080：与后端无关的示例（任意测试域名、CLI 登录回调地址）。worktree 开发环境端口 `18080 + offset` 不是默认端口，保持原样。
- 同步上游时：合并后执行 `git grep -n -w 8080`，凡是指后端的新增出现处一律改成 13840，无关的保留。

## 决策五：局域网广播默认关闭

`MARVIS_LAN_DISCOVERY` 默认关闭（`server/internal/landiscovery/config.go`），设为 true 才广播，所有部署方式一致；上游默认开启。

- 同步上游时 `config.go`、`config_test.go`、`.env.example` 和 `self-host-quickstart*.mdx` 的局域网发现段落冲突：保留默认关闭，只合入上游新增的行为。

## 决策六：状态分组 status_group（fork 独有）

看板四列和状态库共用一套状态分组（未开始 / 工作中 / 需介入 / 已结束），存在 `issue_status.status_group`；`category` 仍是生命周期类型（未开始 / 已开始 / 已完成 / 已关闭），平台行为只读它。为什么不复用 `category` 见 `docs/adr/0001-status-group-column.md`，术语见 `GLOSSARY.md`。

- 规则：工作中和需介入同属已开始，已开始的自定义状态可在两者之间切换；已结束包含已完成和已关闭；内置状态分组固定（审核中、已阻塞是需介入）。迁移 `603_issue_status_group` 用约束锁住合法组合，插入没带分组时触发器按类型给默认值。
- 后端：`issuestatus`（`Group*` 常量、`DefaultGroup`、`ValidGroup`、`Resolver.Group`、`CategoryNameAndGroup`）、状态接口的 `status_group`、任务响应和后台事件的 `status_group`、工作流新建状态可带分组、CLI `--fields status_group`。
- 前端：core 的 `IssueStatusGroup`、`STATUS_GROUP_ORDER`、`defaultStatusGroup`、目录的 `groupOf` / `inGroup`；状态库（`issue-statuses-tab.tsx`）按分组排列、行尾显示生命周期类型；看板、状态选择器、「PR 合并后改为」下拉框按分组排序；工作流模板「等待反馈」放需介入。移动端未对齐。
- 同步上游时：上游新增的按生命周期做行为判断的代码继续用 `category`，不要改读 `status_group`；上游新增的状态插入路径（迁移、种子数据、工作流模板）要带上 `status_group`；`issue-statuses-tab.tsx`、`status-options.ts`、`pr-merge-status-row.tsx` 冲突时保留按分组的结构，只合入上游新增的行为。

## 决策七：通用隐藏指令 instruction（fork 独有）

产品写给智能体、成员看不到的输入统一存成 `chat_message.message_kind = 'instruction'`，上游的 `onboarding_kickoff` 已并入（迁移 `648_chat_message_instruction_kind` 把旧行改成 `instruction`）。

- 语义：随所在轮次的输入批次交给智能体，排在成员消息之前；停止 / 编辑 / 失败时交给下一个排队轮次或变为无主、由下一次发送接管；从不恢复进输入框；所有面向成员的接口、预览和客户端都过滤它。
- 写入：`TaskService.SendDirectChatMessageWithInstruction`（可见消息 + 隐藏指令同一事务）和 `createChatInstruction`（Mika 开场的无主指令）。只用于多步流程的场景：知识库任务的收录、健康检查、合并、定时运行，以及审核意见交接（`server/internal/kb/templates/instructions.md.tmpl`）。
- 同步上游时：上游新增或修改的 `onboarding_kickoff` 判断一律改成 `instruction`（SQL、`protocol`、`chat.go`、`chat-message-list.tsx`、core schema），不要恢复第二个隐藏类型；上游的 `TaskInputIsOnboardingKickoffOnly` 部署窗口兼容逻辑已删除，不要合回。

## 决策八：路径前缀部署（fork 独有）

web 和 docs 支持部署在共享域名的子路径下（如 `/marvis`），由构建参数 `NEXT_PUBLIC_BASE_PATH` 控制，不设时与上游一致；后端始终在根路径，不感知前缀。部署方法见 `SELF_HOSTING_ADVANCED.md` 的 Path Prefix 一节。

- web：`apps/web/config/base-path.ts` 的 `BASE_PATH`，用于 Next 不会自动加前缀的地方：浏览器 API / WS 默认地址（`web-providers.tsx`）、OAuth 回调地址、导航适配器的 `getShareableUrl` 与新标签页、manifest 与图标、favicon 跳转、docs 转发（`runtime-urls.ts`）。
- views：`useAppOrigin` 返回带路径前缀的基地址，`link-handler.ts` 识别站内链接时去掉前缀；裸 `<a href="/download">` 改用 `getShareableUrl`。
- docs：`apps/docs/lib/base-path.ts` 与 `next.config.mjs` 的 basePath 为 `${前缀}/docs`；`Dockerfile.docs`，compose 的 `docs` 服务在 `docs` profile 下。
- 桌面端：服务器地址保留路径（`normalizeServerAddress`），`probeServer` 从完整路径逐级向上探测 `/api/config`，粘贴页面地址也能找到前缀。
- compose：`MARVIS_BIND_ADDRESS` 控制端口绑定地址，默认 `127.0.0.1`；`turbo.json` 的 `globalEnv` 登记了 `NEXT_PUBLIC_BASE_PATH`。
- 生产部署：`make deploy-prod` 经跳板机部署 origin/main 到 prototype，只允许 main 且 CI 的测试与构建作业通过；镜像由 `prod-images.yml` 在 GitHub Actions 构建（prototype 的 CentOS 7 内核下 Node 22 的 `pnpm install` 会 EPERM），服务器只拉取；生产配置是本地主工作区的 `.env.prod`，见 `scripts/deploy/README.md`。
- 同步上游时：上游新增的手拼根路径（`window.location.origin + path`、裸 `href="/..."`、metadata / manifest 里的 public 资源路径）要接上 `BASE_PATH` 或 `getShareableUrl`。

## 决策九：会话来源 chat_session.source（fork 独有）

会话在哪里展示由 `chat_session.source` 决定，与谁执行（`agent_id`）分开：知识库任务和自动化运行的追问照常由用户选的智能体执行，只是不进聊天界面。取值是 `protocol.ChatSessionSource*` 常量，迁移 `650_chat_session_source` 加列、约束并回填，决策记录见 `.scratch/chat-session-source/decisions.md`。

- 取值：`chat`（普通聊天，含 Mika 开局和外部渠道聊天）、`kb_job`（知识库任务）、`autopilot_run`（运行追问）、`kb_builder`、`agent_builder`。
- 写入：`CreateChatSession` 必须传 `Source`；`createKbJobRows`、`ensureAutopilotRunChatSession`、`CreateKbBuilderSession`、`CreateAgentBuilderSession` 各写自己的值，其余路径写 `chat`。
- 读取：聊天列表与未读（`ListChatSessionsByCreator`、`ListAllChatSessionsByCreator`）、运行中指示（`ListPendingChatTasksByCreator`、`HasPendingChatTasksByCreator`）、Mika 会话查找、工作区聊天列表（`ListKbWorkspaceChatSessions`）只读 `chat`；可收录的聊天来源（`ListKbSources`）读 `chat` 和 `autopilot_run`；草稿恢复按 `autopilot_run` 判断共享会话。智能体可见性过滤（`kind = 'user'`）保留不动。`chat_session_source_guard_test.go` 检查这些查询。
- 同步上游时：上游新增的聊天列表类查询加 `source = 'chat'`（以 sqlc 参数传常量）；上游新增的建会话路径必须传 `Source`；不要恢复按 `kb_job` / `autopilot_run` 的 `NOT EXISTS` 排除。

## 同步上游流程

1. `git fetch upstream`，在新分支上 `git merge upstream/main`。
2. 冲突处理：
   - 上游新增/修改内容里的 `multica`：先接受上游版本解决冲突，再统一跑 `python3 scripts/rebrand-marvis.py`，不要手改。
   - 跑完脚本后执行 `(cd server && gofmt -l . | xargs gofmt -w)`：模块路径改名会改变 import 排序和对齐。
   - 上游新增路径（含 `multica`）由脚本 `git mv`，跑完检查 `git status`。
   - 上表列出的样式文件冲突：保留本 fork 的 Marvis 取值，只合入上游新增的 token / 组件 / 变体，并按上面的规则改成 Marvis 风格。
3. 数据库迁移：
   - 上游迁移文本里的旧名由脚本替换；已应用过旧名迁移的库靠 `*_rebrand_marvis`（当前 651）改名，它从系统目录查找旧名对象，幂等。
   - 迁移编号 129 之后必须唯一（`migrations_lint_test.go`）。上游新增编号与 fork 迁移撞号时，fork 迁移整体顺延到上游最大编号之后，`*_rebrand_marvis` 始终排在最后；同步改 `cmd/migrate/main.go` 的并发索引表、脚本 `KEEP` 和引用迁移文件名的测试。版本号按完整文件名记录，改号后会再执行一次：rebrand 迁移幂等，其他 fork 迁移不保证幂等，已跑过的本地库直接重建。
   - 上游新迁移若引入新的旧名数据库对象（列、函数体里的 `multica.*` 设置等），重新执行 589 的改名逻辑（可复制为新编号迁移）。
4. 依赖与校验：`pnpm install`（工作区包名已变），`make sqlc`，`make schema`（重新生成 `server/schema.sql` 完整表结构快照，只读参考，迁移仍是唯一来源），然后 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`make test`。
5. 本地环境：compose 项目名变为 `marvis`，数据卷为 `marvis_pgdata`；改名前创建的 `multica_pgdata` 数据不会自动迁移。`.env` 里的变量名需从 `MULTICA_*` 改为 `MARVIS_*`。旧的 `~/.multica` 里的开发环境与 profile 不会被读取。
6. 改名会改变字符串长度：依赖固定字节数、哈希或校验和的测试夹具（如 `cursor_stdin_unix_test.go` 的 payload、`worktree-dev-env.test.mjs` 的 cksum 路径）需要重新调整。
