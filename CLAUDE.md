@AGENTS.md

# Fork 说明：Marvis（同步上游前必读）

本仓库 fork 自 `multica-ai/multica`，在其基础上做了品牌改名和视觉改造。以下决策会影响每次同步上游，合并时按此处理。

## 远程

- `origin` = `git@github.com:yunboom/marvis.git`（本 fork，提交和推送到这里）
- `upstream` = `https://github.com/multica-ai/multica.git`（上游，只拉取）

## 决策一：品牌全量改名 Multica → Marvis

- 范围是全部被 git 跟踪的文本和路径：代码标识符、注释、文案、文档、CLI 命令（`marvis`）、Go module（`github.com/marvis-ai/marvis/server`）、npm scope（`@marvis/*`）、环境变量（`MARVIS_*`）、配置目录、docker compose 项目名、外部域名和仓库地址（`multica.ai` → `marvis.ai`，`github.com/multica-ai` → `github.com/marvis-ai`）。
- 规则：大小写保持替换（`multica`/`Multica`/`MULTICA` → `marvis`/`Marvis`/`MARVIS`），`multicast` 不替换。
- 改名由 `scripts/rebrand-marvis.py` 完成，脚本幂等，只保留以下文件里的旧名：脚本本身、本文件、`server/migrations/589_rebrand_marvis.*.sql`。新增必须保留旧名的文件时，同步加进脚本的 `KEEP`。
- 外部地址已替换，`marvis.ai` 等域名与 `ghcr.io/marvis-ai` 镜像需自行持有，否则对应链接、镜像拉取、自动更新会失效。

## 决策二：视觉与交互照搬 Marvis.app

- 设计 token（`packages/ui/styles/tokens.css`）：纯中性灰阶、`#f7f7f7` 外壳、`#0f0f0f` 主色、`#7b4835` 品牌色、`0.75rem` 基础圆角、Marvis 阴影；颜色写成等价的 `oklch()`（UI Lab 只认这种格式）。
- 偏离 Marvis 的地方：次要文字 `--muted-foreground` 用 `#666`、`--faint-foreground` 用 `#888`（Marvis 原值 45% 黑达不到 WCAG AA，`apps/web/app/text-contrast.test.ts` 会拦）；hover/selected 等填充色用不透明等效值（sticky 表头不能透出内容）。
- 动效（`packages/ui/styles/base.css`）：菜单 `menu-unfold`（scaleY .8→1，150ms ease-out）、弹层 `popover-pop-in`（scale .92→1）、弹窗 50ms 纯淡入、Tooltip 200ms 淡入、logo `logo-intro`、`spring-rise`。
- 共享组件（`packages/ui/components/ui/` 下 button、dialog、alert-dialog、sheet、dropdown-menu、context-menu、select、popover、hover-card、tooltip、input、textarea、tabs、sidebar）：药丸按钮、填充式输入框、36px 菜单项、分段式 Tabs。
- 字体栈 PingFang SC / Noto Sans SC 优先（`apps/web/app/globals.css`、`apps/desktop/src/renderer/src/globals.css`）。
- Logo：`packages/ui/components/common/marvis-icon.tsx`（圆角方块 + 镂空 "M"），docs 站、移动端、favicon、桌面/PWA/移动端图标已同步；应用侧栏顶部显示 logo + "Marvis" 字标。

## 同步上游流程

1. `git fetch upstream`，在新分支上 `git merge upstream/main`。
2. 冲突处理：
   - 上游新增/修改内容里的 `multica`：先接受上游版本解决冲突，再统一跑 `python3 scripts/rebrand-marvis.py`，不要手改。
   - 上游新增路径（含 `multica`）由脚本 `git mv`，跑完检查 `git status`。
   - 上表列出的样式文件冲突：保留本 fork 的 Marvis 取值，只合入上游新增的 token / 组件 / 变体，并按上面的规则改成 Marvis 风格。
3. 数据库迁移：
   - 上游迁移文本里的旧名由脚本替换；已应用过旧名迁移的库靠 `589_rebrand_marvis` 改名，它从系统目录查找旧名对象，幂等。
   - 上游若也新增了 `589_*` 或之后编号，把 `589_rebrand_marvis` 改到当前最大编号之后（版本号按完整文件名记录，改名后会再执行一次，因为幂等所以安全）。
   - 上游新迁移若引入新的旧名数据库对象（列、函数体里的 `multica.*` 设置等），重新执行 589 的改名逻辑（可复制为新编号迁移）。
4. 依赖与校验：`pnpm install`（工作区包名已变），`make sqlc`，然后 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`make test`。
5. 本地环境：compose 项目名变为 `marvis`，数据卷为 `marvis_pgdata`；改名前创建的 `multica_pgdata` 数据不会自动迁移。`.env` 里的变量名需从 `MULTICA_*` 改为 `MARVIS_*`。
