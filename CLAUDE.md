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
- 改名由 `scripts/rebrand-marvis.py` 完成，脚本幂等，只保留以下文件里的旧名：脚本本身、本文件、`server/migrations/589_rebrand_marvis.*.sql`。新增必须保留旧名的文件时，同步加进脚本的 `KEEP`。
- `marvis.ai` 等域名需自行持有，否则对应链接失效。

## 决策一补充：避开本机腾讯 Marvis.app 已占用的标识（marvis-studio）

腾讯 Marvis.app 占用了 `~/.marvis`（软链到它的用户数据目录）、`marvis://` URL scheme 和 `/Applications/Marvis.app` / `Application Support/Marvis`。本 fork 的机器级标识改用 marvis-studio，品牌展示仍是 Marvis：

- 家目录：`~/.marvis-studio`（CLI 配置、daemon、profiles、开发环境注册表 `~/.marvis-studio/dev`）。
- 桌面端深链 scheme：`marvis-studio://`。
- 桌面端打包名 / userData / WM_CLASS：`Marvis Studio`（即 `/Applications/Marvis Studio.app`），开发模式仍是 `Marvis Canary`。
- 任务工作目录内的 `.marvis/`（如 `.marvis/project/resources.json`）不在家目录，不冲突，保持不变。
- 以上规则在 `scripts/rebrand-marvis.py` 的 `STUDIO_RULES`，仓库地址规则在 `FORK_RULES`；上游新增类似写法（新的家目录拼接方式等）时补规则，不手改。

## 决策二：视觉与交互照搬 Marvis.app

- 设计 token（`packages/ui/styles/tokens.css`）：纯中性灰阶、`#f7f7f7` 外壳、`#0f0f0f` 主色、`#7b4835` 品牌色、`0.75rem` 基础圆角、Marvis 阴影；颜色写成等价的 `oklch()`（UI Lab 只认这种格式）。
- 偏离 Marvis 的地方：次要文字 `--muted-foreground` 用 `#666`、`--faint-foreground` 用 `#888`（Marvis 原值 45% 黑达不到 WCAG AA，`apps/web/app/text-contrast.test.ts` 会拦）；hover/selected 等填充色用不透明等效值（sticky 表头不能透出内容）。
- 动效（`packages/ui/styles/base.css`）：菜单 `menu-unfold`（scaleY .8→1，150ms ease-out）、弹层 `popover-pop-in`（scale .92→1）、弹窗 50ms 纯淡入、Tooltip 200ms 淡入、logo `logo-intro`、`spring-rise`。
- 共享组件（`packages/ui/components/ui/` 下 button、dialog、alert-dialog、sheet、dropdown-menu、context-menu、select、popover、hover-card、tooltip、input、textarea、tabs、sidebar）：药丸按钮、填充式输入框、36px 菜单项、分段式 Tabs。
- 字体栈 PingFang SC / Noto Sans SC 优先（`apps/web/app/globals.css`、`apps/desktop/src/renderer/src/globals.css`）。
- Logo：`packages/ui/components/common/marvis-icon.tsx`（圆角方块 + 镂空 "M"），docs 站、移动端、favicon、桌面/PWA/移动端图标已同步；应用侧栏顶部显示 logo + "Marvis" 字标。

## 决策三：飞书登录（fork 独有）

- 国内飞书网页 OAuth 登录 + 飞书客户端内免登，按邮箱匹配账号，与 Google 登录同构。
- 服务端：`server/internal/handler/auth_lark.go`（`POST /auth/lark`，路由在 `cmd/server/router.go`）；`auth.go` 的 GoogleLogin 尾段抽成 `completeOAuthLogin` 两者共用；`config.go` 下发 `lark_login_app_id`。
- 环境变量：`MARVIS_LARK_LOGIN_APP_ID`、`MARVIS_LARK_LOGIN_APP_SECRET`、`MARVIS_LARK_LOGIN_TENANT_KEYS`（`.env.example`、`docker-compose.selfhost.yml`）。
- 前端：`packages/views/auth/login-page.tsx`（飞书按钮、`lark` / `onLarkLogin`）、`use-lark-client-login.ts`（客户端免登）、`apps/web/app/(auth)/login/page.tsx`、`apps/web/app/auth/callback/page.tsx`（state 带 `provider:lark` 时走飞书）、`callback-error.ts`、桌面端 `pages/login.tsx`、core 的 `larkLogin` / `loginWithLark` / `larkLoginAppId`、auth 语言包。
- 同步上游时 `auth.go`、`login-page.tsx`、`callback/page.tsx` 易冲突：保留上游改动后重新接回飞书分支，并跑 `Lark|Google` 相关测试。

## 同步上游流程

1. `git fetch upstream`，在新分支上 `git merge upstream/main`。
2. 冲突处理：
   - 上游新增/修改内容里的 `multica`：先接受上游版本解决冲突，再统一跑 `python3 scripts/rebrand-marvis.py`，不要手改。
   - 跑完脚本后执行 `(cd server && gofmt -l . | xargs gofmt -w)`：模块路径改名会改变 import 排序和对齐。
   - 上游新增路径（含 `multica`）由脚本 `git mv`，跑完检查 `git status`。
   - 上表列出的样式文件冲突：保留本 fork 的 Marvis 取值，只合入上游新增的 token / 组件 / 变体，并按上面的规则改成 Marvis 风格。
3. 数据库迁移：
   - 上游迁移文本里的旧名由脚本替换；已应用过旧名迁移的库靠 `589_rebrand_marvis` 改名，它从系统目录查找旧名对象，幂等。
   - 上游若也新增了 `589_*` 或之后编号，把 `589_rebrand_marvis` 改到当前最大编号之后（版本号按完整文件名记录，改名后会再执行一次，因为幂等所以安全）。
   - 上游新迁移若引入新的旧名数据库对象（列、函数体里的 `multica.*` 设置等），重新执行 589 的改名逻辑（可复制为新编号迁移）。
4. 依赖与校验：`pnpm install`（工作区包名已变），`make sqlc`，然后 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`make test`。
5. 本地环境：compose 项目名变为 `marvis`，数据卷为 `marvis_pgdata`；改名前创建的 `multica_pgdata` 数据不会自动迁移。`.env` 里的变量名需从 `MULTICA_*` 改为 `MARVIS_*`。旧的 `~/.multica` 里的开发环境与 profile 不会被读取。
6. 改名会改变字符串长度：依赖固定字节数、哈希或校验和的测试夹具（如 `cursor_stdin_unix_test.go` 的 payload、`worktree-dev-env.test.mjs` 的 cksum 路径）需要重新调整。
