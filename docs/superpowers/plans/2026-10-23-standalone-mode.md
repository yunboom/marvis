# 单机模式实现计划（阶段一：服务端）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让服务端具备单机模式所需的全部开关：可指定监听地址、局域网广播默认关闭、单机模式下固定验证码在 production 生效、主机管理员一次性自动登录，并能打出单机模式下载包。

**Architecture:** 服务端只加环境变量驱动的行为，不改表结构。单机模式下载包与 Docker 镜像同构：`server`、`migrate` 两个二进制加 `migrations/` 目录，桌面端先跑 `migrate up` 再启动 `server`（与 `docker/entrypoint.sh` 一致），`migrations.ResolveDir()` 已会在可执行文件旁查找 `migrations/`。

**Tech Stack:** Go（chi、pgx）、bash、xz。

**Spec:** 技术方案文档「Marvis 单机模式技术方案」https://claude.ai/artifact/KPv4K4s7TjFGaHoHRUYvSy ；设计稿 https://claude.ai/artifact/8JtMci5WWr68cixGLKptzZ （38–42 号画板）。

## 阶段路线

整个功能拆成六个阶段，每个阶段单独可验证、单独提交；本文件只展开阶段一，后续阶段到达时再写各自的计划文件。

| 阶段 | 内容 | 交付物 |
| --- | --- | --- |
| 一（本文件） | 服务端开关 + 下载包构建脚本 | 本机可打出 `marvis-server-<ver>-<os>-<arch>.tar.xz` |
| 二 | 发布流水线：goreleaser 构建下载包、`postgres-bundle.yml` 去重重打包 zonky、`server-manifest.json` | Release 上有 manifest 与两类包 |
| 三 | 桌面端主进程基础：配置 schema 与随机密钥、断点续传下载、校验、解压、目录与 safeStorage | 主进程单测覆盖续传与校验 |
| 四 | 桌面端运行时：PostgreSQL 与服务端子进程、退出时停服、`server.json` 新增 `standalone`、bootstrap 自动登录、IPC | 主进程能把单机模式跑起来 |
| 五 | 界面：38 选择服务器、39 完成设置、40 准备资源、41 设置 · 服务器、42 设置 · 更新、五语言文案 | 首次启动全流程可用 |
| 六 | 资源更新与回滚、切换到远程服务器 | 41/42 号画板的全部状态 |

## Global Constraints

- 新增环境变量名：`MARVIS_LISTEN_HOST`、`MARVIS_STANDALONE`、`MARVIS_BOOTSTRAP_TOKEN`；不新增其他变量。
- `MARVIS_LAN_DISCOVERY` 默认改为关闭，所有部署方式一致；显式设为 true 才广播。
- `APP_ENV` 语义不变：单机模式仍是 production，保留 `jwtSecretBootError` 的生产检查。
- 固定验证码仍是 6 位数字（`isSixDigitCode`），不改登录页。
- 不新增表、不加迁移。
- 后端默认端口 13840（仓库 CLAUDE.md 决策四）。
- 错误处理用 `github.com/pkg/errors` 包装后上抛；错误、日志文案英文；注释语言跟随所在文件。
- 改完的 Go 文件跑 `gofmt` 与 `goimports -local github.com/yunboom/marvis/server`；import 三组：标准库 / 第三方 / 本仓库。
- 导出标识符必须有以名字开头的注释。

## Review Focus

1. **bootstrap 被局域网调用**：开了局域网连接后，局域网内任何人都能请求 `/auth/bootstrap`；必须只认 TCP 对端是回环地址，`X-Forwarded-For` 之类的头一律不看。→ Task 4 测试 `TestBootstrapLoginRejectsNonLoopback`（`RemoteAddr` 为 `192.168.1.37:50000`、带 `X-Forwarded-For: 127.0.0.1` 时仍返回 403）。
2. **bootstrap 被重放**：token 泄漏后第二次调用必须失败，且并发两次只能成功一次。→ Task 4 测试 `TestBootstrapLoginIsSingleUse`。
3. **非单机部署误开固定验证码**：普通生产部署只设了 `MARVIS_DEV_VERIFICATION_CODE`、没设 `MARVIS_STANDALONE` 时必须仍被忽略。→ Task 3 保留并运行 `TestVerifyCodeRejectsConfiguredDevCodeInProduction`。
4. **`MARVIS_STANDALONE` 的取值**：`1`、`true`、`TRUE` 视为开启，`0`、`false`、空、乱写都视为关闭，不能因为乱写就开启。→ Task 3 测试 `TestIsStandaloneMode` 表驱动。
5. **IPv6 监听地址**：`MARVIS_LISTEN_HOST=::1` 必须得到 `[::1]:13840`，不能拼成 `::1:13840`。→ Task 1 测试用例。

---

### Task 1: 可配置监听地址 `MARVIS_LISTEN_HOST`

**Files:**
- Modify: `server/cmd/server/main.go`（`newMainHTTPServer(":"+port, r)` 处，约 :721）
- Test: `server/cmd/server/main_test.go`
- Modify: `.env.example`（`PORT` 附近补一段说明）

**Interfaces:**
- Produces: `func mainListenAddr(host, port string) string`（`cmd/server/main.go`），空 host 返回 `":"+port`，否则 `net.JoinHostPort(host, port)`。阶段四桌面端在局域网关闭时传 `MARVIS_LISTEN_HOST=127.0.0.1`。

- [ ] **Step 1: 写失败测试 `TestMainListenAddr`**

```go
func TestMainListenAddr(t *testing.T) {
	cases := []struct{ host, port, want string }{
		{"", "13840", ":13840"},
		{"  ", "13840", ":13840"},
		{"127.0.0.1", "13840", "127.0.0.1:13840"},
		{"::1", "13840", "[::1]:13840"},
		{"0.0.0.0", "18080", "0.0.0.0:18080"},
	}
	for _, c := range cases {
		if got := mainListenAddr(c.host, c.port); got != c.want {
			t.Errorf("mainListenAddr(%q, %q) = %q, want %q", c.host, c.port, got, c.want)
		}
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && go test ./cmd/server -run TestMainListenAddr -count=1`
Expected: FAIL（`undefined: mainListenAddr`）

- [ ] **Step 3: 实现 `mainListenAddr`，main 中改为 `newMainHTTPServer(mainListenAddr(os.Getenv("MARVIS_LISTEN_HOST"), port), r)`**；host 先 `strings.TrimSpace`。`.env.example` 补一行注释：留空监听所有网卡，单机模式关闭局域网时由桌面端设为 `127.0.0.1`。

- [ ] **Step 4: 运行确认通过**

Run: `cd server && go test ./cmd/server -run 'TestMainListenAddr|TestNewMainHTTPServerTimeouts' -count=1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/cmd/server/main.go server/cmd/server/main_test.go .env.example
git commit -m "feat(server): make the listen host configurable"
```

### Task 2: 局域网广播默认关闭

**Files:**
- Modify: `server/internal/landiscovery/config.go:66-75`（`ConfigFromEnv` 默认 `Enabled: false`，注释同步）
- Test: `server/internal/landiscovery/config_test.go`（`TestConfigFromEnv` 期望改为 `Enabled: false`，新增显式开启用例）
- Modify: `.env.example:293-302`（「default: on」改为「default: off」，说明设为 true 才广播）
- Modify: `apps/docs/content/docs/self-host-quickstart{,.zh,.fr,.ja,.ko}.mdx`、`apps/docs/content/docs/desktop-app.zh.mdx` 中「默认开启」的描述
- Modify: 仓库根 `CLAUDE.md`：新增「决策五：局域网广播默认关闭」，写明与上游不同、同步上游时保留

**Interfaces:**
- Produces: `landiscovery.ConfigFromEnv` 在未设 `MARVIS_LAN_DISCOVERY` 时返回 `Enabled == false`。

- [ ] **Step 1: 改测试**：`TestConfigFromEnv` 只设 `PORT` 时期望 `Config{Enabled: false, Name: "design-mac-mini", Port: 13900}`；新增 `TestConfigFromEnvEnabledExplicitly`：`MARVIS_LAN_DISCOVERY=true` → `Enabled: true`；`MARVIS_LAN_DISCOVERY=garbage` → `Enabled: false`。

- [ ] **Step 2: 运行确认失败**

Run: `cd server && go test ./internal/landiscovery -count=1`
Expected: FAIL（默认值仍为 true）

- [ ] **Step 3: 把默认值改为 false**，`strconv.ParseBool` 解析失败时保持 false；同步 `.env.example`、六个 mdx、`CLAUDE.md`。

- [ ] **Step 4: 运行确认通过**

Run: `cd server && go test ./internal/landiscovery ./cmd/server -run 'TestConfigFromEnv|TestStartLANAdvertising|TestLANConfigForListenPort' -count=1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/internal/landiscovery .env.example apps/docs/content/docs CLAUDE.md
git commit -m "feat(server): turn LAN discovery off by default"
```

### Task 3: `MARVIS_STANDALONE` 让固定验证码在 production 生效

**Files:**
- Modify: `server/internal/handler/auth.go:137-152`（`isDevVerificationCode` 的 production 判断）
- Create: `server/internal/handler/standalone.go`（`StandaloneEnv` 常量与 `IsStandaloneMode`）
- Test: `server/internal/handler/standalone_test.go`（纯函数，不连库）
- Test: `server/internal/handler/handler_test.go`（`:2350` 附近新增 DB 用例）
- Modify: `server/cmd/server/main.go:349-354`（警告分支）

**Interfaces:**
- Produces: `const StandaloneEnv = "MARVIS_STANDALONE"`；`func IsStandaloneMode() bool`（`strconv.ParseBool` 为 true 才返回 true，解析失败返回 false）。阶段四桌面端启动单机服务端时设 `MARVIS_STANDALONE=1`；Task 4 的路由注册也读它。

- [ ] **Step 1: 写失败测试 `TestIsStandaloneMode`**（表驱动：`"1"`、`"true"`、`"TRUE"` → true；`""`、`"0"`、`"false"`、`"yes"`、`"garbage"` → false，用 `t.Setenv(StandaloneEnv, v)`）。

- [ ] **Step 2: 在 `handler_test.go` 写失败测试 `TestVerifyCodeAcceptsConfiguredDevCodeInStandaloneProduction`**：照 `TestVerifyCodeAcceptsConfiguredDevCodeOutsideProduction` 的写法，额外 `t.Setenv("APP_ENV", "production")`、`t.Setenv(StandaloneEnv, "1")`，断言返回 200 且响应含 token。

- [ ] **Step 3: 运行确认失败**

Run: `cd server && go test ./internal/handler -run 'TestIsStandaloneMode|TestVerifyCode.*DevCode' -count=1`
Expected: FAIL（`undefined: IsStandaloneMode`）

- [ ] **Step 4: 实现**：`isDevVerificationCode` 改为 `isProductionEnv() && !IsStandaloneMode()` 时返回 false；`main.go` 警告：production 且非单机时打 "ignored"，否则打 "enabled"（单机时消息带上 `standalone=true` 字段）。

- [ ] **Step 5: 运行确认通过（含原有的拒绝用例）**

Run: `cd server && go test ./internal/handler -run 'TestIsStandaloneMode|TestVerifyCode' -count=1`
Expected: PASS，`TestVerifyCodeRejectsConfiguredDevCodeInProduction` 仍通过

- [ ] **Step 6: 提交**

```bash
git add server/internal/handler/standalone.go server/internal/handler/standalone_test.go server/internal/handler/auth.go server/internal/handler/handler_test.go server/cmd/server/main.go
git commit -m "feat(server): honor the fixed login code in standalone mode"
```

### Task 4: 主机管理员一次性自动登录 `POST /auth/bootstrap`

**Files:**
- Create: `server/internal/handler/auth_bootstrap.go`
- Test: `server/internal/handler/auth_bootstrap_test.go`
- Modify: `server/internal/handler/handler.go`（`Config` 新增 `BootstrapToken string`；`Handler` 新增 `bootstrapUsed atomic.Bool`）
- Modify: `server/cmd/server/router.go`（`RouterOptions` 新增 `Standalone bool`、`BootstrapToken string`；在 `/auth/verify-code` 旁按 `opts.Standalone && opts.BootstrapToken != ""` 注册路由，挂 `authVerifyRL`）
- Modify: `server/cmd/server/main.go`（读 `MARVIS_BOOTSTRAP_TOKEN` 与 `handler.IsStandaloneMode()` 传入 `RouterOptions`）

**Interfaces:**
- Consumes: `handler.IsStandaloneMode()`（Task 3）；现有 `findOrCreateUser(ctx, email)`、`issueJWT(user)`、`auth.SetAuthCookies(w, token)`、`LoginResponse`。
- Produces: `POST /auth/bootstrap`，请求 `BootstrapLoginRequest{Token string \`json:"token"\`; Email string \`json:"email"\`}`，成功返回与 `VerifyCode` 相同的 `LoginResponse` 并写登录 cookie。阶段四桌面端主进程在服务端就绪后调用它。

状态码约定（测试按此断言）：

| 情况 | 状态码 |
| --- | --- |
| 未配置 token（理论上路由不注册，handler 也自检） | 404 |
| TCP 对端不是回环地址（只看 `r.RemoteAddr`，不看任何代理头） | 403 |
| body 非法或邮箱格式不对 | 400 |
| token 不匹配（`subtle.ConstantTimeCompare`） | 401 |
| token 已用过 | 410 |
| 成功 | 200 |

- [ ] **Step 1: 写失败测试**（`auth_bootstrap_test.go`，复用 `handler_test.go` 的 `TestMain`/`testHandler` 方式，各用例新建带 `Config{BootstrapToken: "tok"}` 的 handler，`t.Cleanup` 删除创建的用户）：
  - `TestBootstrapLoginCreatesUserAndSession`：`RemoteAddr="127.0.0.1:50000"`，返回 200，响应 `token` 非空，`Set-Cookie` 含登录 cookie，库中存在该邮箱用户
  - `TestBootstrapLoginIsSingleUse`：第二次同参数请求返回 410；另起两个 goroutine 并发调用新 handler，恰好一个 200
  - `TestBootstrapLoginRejectsNonLoopback`：`RemoteAddr="192.168.1.37:50000"` 且带 `X-Forwarded-For: 127.0.0.1` → 403
  - `TestBootstrapLoginRejectsWrongToken` → 401，且之后用正确 token 仍可成功（错误 token 不消耗一次性名额）
  - `TestBootstrapLoginNotConfigured`：`BootstrapToken` 为空 → 404
  - `TestBootstrapLoginAcceptsIPv6Loopback`：`RemoteAddr="[::1]:50000"` → 200

- [ ] **Step 2: 运行确认失败**

Run: `cd server && go test ./internal/handler -run TestBootstrapLogin -count=1`
Expected: FAIL（`undefined: BootstrapLoginRequest` 等）

- [ ] **Step 3: 实现 `func (h *Handler) BootstrapLogin(w http.ResponseWriter, r *http.Request)`**：顺序为 配置 → 回环 → 解析 → token → `bootstrapUsed.CompareAndSwap(false, true)` → `findOrCreateUser` → `issueJWT` → cookie + JSON；后续步骤出错时 `bootstrapUsed.Store(false)` 允许重试，错误用 `errors.Wrapf(err, "bootstrap login email=%s", email)` 记录。路由与 main 接线同上。

- [ ] **Step 4: 运行确认通过**

Run: `cd server && go test ./internal/handler -run 'TestBootstrapLogin|TestVerifyCode' -count=1 && go test ./cmd/server -count=1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/internal/handler/auth_bootstrap.go server/internal/handler/auth_bootstrap_test.go server/internal/handler/handler.go server/cmd/server/router.go server/cmd/server/main.go
git commit -m "feat(server): add one-time loopback bootstrap login for standalone mode"
```

### Task 5: 单机模式下载包构建脚本

**Files:**
- Create: `scripts/build-standalone-bundle.sh`
- Modify: `Makefile`（新增 `standalone-bundle` 目标，默认当前平台）

**Interfaces:**
- Produces: `scripts/build-standalone-bundle.sh <goos> <goarch> <version> <outdir>`，产出 `<outdir>/marvis-server-<version>-<os>-<arch>.tar.xz` 与同名 `.sha256`；包内根目录为 `server`、`migrate`（Windows 为 `.exe`）、`migrations/`。`<os>` 用 darwin/linux/windows，`<arch>` 用 amd64/arm64（与 `cli-release-asset.ts` 命名一致）。阶段二的发布流水线调用此脚本。

- [ ] **Step 1: 写脚本**：`set -euo pipefail`；两个二进制都用 `CGO_ENABLED=0 GOOS GOARCH go build -trimpath -ldflags "-s -w -X main.version=<version>"`（`migrate` 不带 version）；复制 `server/migrations/*.sql`；`tar -cf - -C <staging> . | xz -9 -T0 > <outfile>`；`shasum -a 256` 写 `.sha256`；参数不全时打印用法并退出 2。

- [ ] **Step 2: 本机打包并检查内容**

Run: `make standalone-bundle VERSION=0.0.0-dev && tar -tJf server/dist/marvis-server-0.0.0-dev-$(go env GOOS)-$(go env GOARCH).tar.xz | grep -E '^\./(server|migrate|migrations/001_init.up.sql)$'`
Expected: 三行全部命中；记录包大小写入阶段二计划

- [ ] **Step 3: 冒烟：解压后在空库上跑迁移并启动**

Run（本机 PostgreSQL 来自 `make up` 的环境，库名用一次性的 `standalone_smoke`）：解压到临时目录，`DATABASE_URL=<smoke 库> ./migrate up`，再 `APP_ENV=production MARVIS_STANDALONE=1 MARVIS_LISTEN_HOST=127.0.0.1 PORT=13999 JWT_SECRET=<64 位随机十六进制> DATABASE_URL=<smoke 库> ./server &`，`curl -s 127.0.0.1:13999/readyz`
Expected: `migrate` 输出 `Done.`，`/readyz` 返回 200；结束后删除 smoke 库

- [ ] **Step 4: 提交**

```bash
git add scripts/build-standalone-bundle.sh Makefile
git commit -m "build: add standalone server bundle script"
```

### Task 6: 同步技术方案与 lint

**Files:**
- 技术方案文档（Claude Docs）：「下载产物与体积」改为下载包含 `server`、`migrate`、`migrations/`，去掉 go:embed 与 `MARVIS_AUTO_MIGRATE`，体积用 Task 5 实测值；「改动清单」服务端一行同步

- [ ] **Step 1: 全量跑本阶段相关包测试与格式检查**

Run: `cd server && gofmt -l ./cmd/server ./internal/handler ./internal/landiscovery && go vet ./cmd/server ./internal/handler ./internal/landiscovery && go test ./cmd/server ./internal/handler ./internal/landiscovery -count=1`
Expected: `gofmt -l` 无输出，vet 与测试全部通过

- [ ] **Step 2: 更新技术方案文档对应段落**（通过 Claude Docs 连接器按段落替换）
