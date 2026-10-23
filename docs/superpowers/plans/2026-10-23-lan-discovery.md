# 局域网自动发现服务端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 服务端（源码方式运行在 Mac 上）在局域网广播自己；桌面端和命令行发现、核实、确认后连接；掉线和换 IP 时桌面端能恢复。

**Architecture:** 后端进程用 mDNS / DNS-SD 广播 `_marvis._tcp` 和主机名 `marvis.local`，端口是网页端口；网页端已把 `/api`、`/ws` 转给后端，所以客户端只用一个地址。客户端用 `GET /api/config`（新增 `server_name`、`instance_id`）核实身份。桌面端在 Electron 主进程做发现、探测、保存和掉线监测，渲染进程只做界面；命令行在 `setup self-host` 里加交互式选择。

**Tech Stack:** Go（`github.com/libp2p/zeroconf/v2` v2.2.0）、Electron 主进程（`bonjour-service` 1.3.0）、React + Tailwind（桌面端渲染进程）、vitest、Go test。

**Spec:** `docs/superpowers/specs/2026-10-23-lan-discovery-design.md`；界面以 Marvis 设计稿 20–23 号画板为准（https://claude.ai/artifact/8JtMci5WWr68cixGLKptzZ）。

## Global Constraints

- 服务类型 `_marvis._tcp`；TXT 键固定为 `v`（值 `1`）、`name`、`ver`、`id`。
- 广播后端实际监听的端口（默认 `13840`，已由端口迁移提交改好）；桌面端和命令行只连后端地址；网页端可选。
- 主机名固定 `marvis`，冲突时依次 `marvis-2`、`marvis-3`…；不提供主机名配置项。
- 服务端配置只有两个可选环境变量：`MARVIS_LAN_DISCOVERY`（为 `false` 时不广播，默认广播）、`MARVIS_LAN_NAME`（默认电脑名去掉 `.local`）。
- 输入框默认地址 `http://marvis.local:13840`。
- 实例 ID 复用 `instance_telemetry_state.instance_id`，不加迁移。
- 网页地址可选：取 `/api/config` 的 `daemon_app_url`，仅当其主机不是回环地址（localhost、127.0.0.1、::1）时采用；没有时 `appUrl` 为空字符串。
- “版本过旧”的判定：`/api/config` 响应里没有 `instance_id`。
- 桌面端已选服务器存 `<userData>/server.json`（macOS 为 `~/Library/Application Support/Marvis/server.json`）；`~/.marvis/desktop.json` 只读、只作初始值。
- 桌面端永不读写 `~/.marvis/config.json`；命令行永不写桌面端数据（#6399）。
- 发现结果必须经 `/api/config` 核实并由用户确认后才连接；不自动登录。
- Go 遵守 `~/.claude/CLAUDE.md`：错误用 `github.com/pkg/errors` 包装、错误/日志英文、注释中文、词表值用具名常量、import 分三组；改动包 `golangci-lint run --new-from-rev=<起点提交>` 零告警。
- 不在循环里串行调用外部资源：多个候选服务器的 `/api/config` 探测并发发出。
- 界面文案放 `packages/views/locales/<lang>/settings.json` 的 `desktop.server` 下，五种语言同步（parity 测试必须通过）；中文按下文文案表逐字使用。命令行输出沿用现有命令行的英文。
- 样式只用现有 tokens / 组件（见 `packages/ui`），`pnpm check:ui-radii` 通过。

## Review Focus

1. **服务器 Mac 有多块网卡**（Wi-Fi、有线、VPN 的 utun、虚拟网卡）：只广播已启用、非回环、非点对点、私有网段的 IPv4。测试：Task 1 `TestAdvertiseIPs`。
2. **同一台服务器被多次发现**（多个 IP、重复通告）：按实例 ID 去重，只显示一行。测试：Task 4 `dedupes by instanceId`、Task 8 `TestMergeCandidates`。
3. **用户随手输入的地址**：`192.168.1.20:3000`、`marvis.local:3000/`、`http://marvis.local:3000/login` 都应规范成 origin。测试：Task 3 `normalizeServerAddress`。
4. **3000 端口上是别的程序**（返回 HTML 或 404），或地址根本不通：前者判为“不是 Marvis 服务器”，后者 3 秒内判为“无法连接”，都不能崩。测试：Task 3 `probeServer` 四种结果。
5. **电脑休眠唤醒、换 Wi-Fi**：掉线检测不能刷屏；恢复后回到在线并收起提示。测试：Task 7 `server watch transitions`（假时钟）。

---

## 文案表（zh-Hans，键都在 `settings.json` → `desktop.server`）

| 键 | 中文 |
|---|---|
| `connect.title` | 连接到 Marvis 服务器 |
| `connect.subtitle` | 选择局域网中的服务器，或输入地址 |
| `connect.subtitle_none` | 输入服务器地址 |
| `connect.lan_heading` | 局域网中的服务器 |
| `connect.scanning` | 正在查找 |
| `connect.rescan` | 重新查找 |
| `connect.local_badge` | 本机 |
| `connect.none` | 局域网中没有找到服务器。电脑和服务器需要连在同一个局域网。 |
| `connect.continue` | 继续 |
| `address.label` | 服务器地址 |
| `address.test` | 测试连接 |
| `address.testing` | 正在测试 |
| `probe.ok` | 可以连接 · {{name}} · {{version}} |
| `probe.unreachable` | 无法连接到这个地址 |
| `probe.not_marvis` | 这个地址不是 Marvis 服务器 |
| `probe.too_old` | 服务器版本过旧 |
| `confirm.title` | 连接到 {{name}}？ |
| `confirm.subtitle` | 核对地址，确认是你要使用的服务器 |
| `confirm.address` / `confirm.version` / `confirm.host` | 地址 / 版本 / 主机名 |
| `confirm.http_warning` | 这个服务器使用 HTTP 连接，同一网络中的设备可能看到传输的内容。 |
| `confirm.back` / `confirm.connect` / `confirm.connecting` | 返回 / 连接 / 正在连接... |
| `settings.title` | 服务器 |
| `settings.description` | 这台电脑连接的 Marvis 服务器。切换后需要重新登录。 |
| `settings.connected` / `settings.offline` | 已连接 / 无法连接 |
| `settings.other_address` | 其他地址 |
| `settings.switch` | 切换 |
| `settings.switch_title` | 切换到 {{name}}？ |
| `settings.switch_body` | 会退出当前账号，连接到 {{address}} 后重新登录。 |
| `settings.cancel` | 取消 |
| `banner.reconnecting` | 与 {{name}} 的连接已断开，正在重新连接… |
| `banner.unreachable` | 无法连接到 {{name}}（{{address}}）。页面内容可能不是最新的。 |
| `banner.retry` / `banner.switch` | 重试 / 切换服务器 |
| `moved.title` / `moved.body` | 已重新连接到 {{name}} / 服务器地址变为 {{address}}，已自动更新 |
| `replaced.title` | 这个地址上换了一台服务器 |
| `replaced.body` | {{address}} 现在是“{{other}}”，不是你之前连接的“{{name}}”。为避免连错，没有自动切换。 |
| `replaced.wait` / `replaced.switch` | 继续等待 / 切换服务器 |
| `tab_label` | 服务器 |

---

### Task 1: 服务端广播的纯逻辑

**Files:**
- Create: `server/internal/landiscovery/config.go`、`server/internal/landiscovery/hostname.go`、`server/internal/landiscovery/instance.go`
- Test: `server/internal/landiscovery/config_test.go`、`server/internal/landiscovery/hostname_test.go`

**Interfaces:**
- Produces:
  - 常量 `ServiceType = "_marvis._tcp"`、`Domain = "local."`、`ProtocolVersion = "1"`、`DefaultHostname = "marvis"`、`DefaultFrontendPort = 3000`；TXT 键常量 `TXTKeyVersion = "v"`、`TXTKeyName = "name"`、`TXTKeyServerVersion = "ver"`、`TXTKeyInstanceID = "id"`。
  - `type Config struct { Enabled bool; Name string; Port int }`
  - `func ConfigFromEnv(getenv func(string) string, hostname func() (string, error)) Config`
  - `type Iface struct { Name string; Up, Loopback, PointToPoint bool; Addrs []net.IP }`
  - `func AdvertiseIPs(ifaces []Iface) []net.IP`
  - `func ChooseHostname(taken []string) string`
  - `func TXTRecords(name, serverVersion, instanceID string) []string`（返回 `key=value` 列表，顺序 v、name、ver、id）
  - `func LoadInstanceID(ctx context.Context, pool *pgxpool.Pool) (string, error)`

- [ ] **Step 1: 写失败的测试**

```go
func TestConfigFromEnv(t *testing.T) {
	host := func() (string, error) { return "design-mac-mini.local", nil }
	env := map[string]string{"FRONTEND_PORT": "3100"}
	cfg := ConfigFromEnv(func(k string) string { return env[k] }, host)
	require.Equal(t, Config{Enabled: true, Name: "design-mac-mini", Port: 3100}, cfg)

	env = map[string]string{"MARVIS_LAN_DISCOVERY": "false", "MARVIS_LAN_NAME": "设计部 Marvis"}
	cfg = ConfigFromEnv(func(k string) string { return env[k] }, host)
	require.Equal(t, Config{Enabled: false, Name: "设计部 Marvis", Port: 3000}, cfg)
}

func TestAdvertiseIPs(t *testing.T) {
	ifaces := []Iface{
		{Name: "lo0", Up: true, Loopback: true, Addrs: []net.IP{net.ParseIP("127.0.0.1")}},
		{Name: "en0", Up: true, Addrs: []net.IP{net.ParseIP("192.168.1.20"), net.ParseIP("fe80::1")}},
		{Name: "utun3", Up: true, PointToPoint: true, Addrs: []net.IP{net.ParseIP("10.8.0.2")}},
		{Name: "en7", Up: false, Addrs: []net.IP{net.ParseIP("192.168.2.9")}},
		{Name: "en1", Up: true, Addrs: []net.IP{net.ParseIP("8.8.8.8"), net.ParseIP("169.254.3.3")}},
	}
	require.Equal(t, []net.IP{net.ParseIP("192.168.1.20")}, AdvertiseIPs(ifaces))
}

func TestChooseHostname(t *testing.T) {
	require.Equal(t, "marvis", ChooseHostname(nil))
	require.Equal(t, "marvis-2", ChooseHostname([]string{"marvis.local."}))
	require.Equal(t, "marvis-3", ChooseHostname([]string{"marvis.local.", "Marvis-2.local."}))
}

func TestTXTRecords(t *testing.T) {
	require.Equal(t, []string{"v=1", "name=设计部 Marvis", "ver=v0.6.5", "id=7f3a"},
		TXTRecords("设计部 Marvis", "v0.6.5", "7f3a"))
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && go test ./internal/landiscovery/`
Expected: FAIL（undefined: ConfigFromEnv 等）

- [ ] **Step 3: 实现上述函数**

`AdvertiseIPs` 只保留 IPv4 且 `ip.IsPrivate()`（排除链路本地）；`ChooseHostname` 比较时忽略大小写和 `.local.` 后缀。`LoadInstanceID` 先执行 `INSERT INTO instance_telemetry_state (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`，再 `SELECT instance_id ... WHERE singleton = true`，与 `internal/selfhosttelemetry/store.go:79-104` 同一写法；SQL 写成包内常量。

- [ ] **Step 4: 运行确认通过**

Run: `cd server && go test ./internal/landiscovery/ && golangci-lint run --new-from-rev=HEAD ./internal/landiscovery/`
Expected: PASS，0 issues

- [ ] **Step 5: Commit**

```bash
git add server/internal/landiscovery
git commit -m "feat(server): LAN discovery config, address and hostname selection"
```

---

### Task 2: 服务端广播运行、核实接口与同源放行

**Files:**
- Create: `server/internal/landiscovery/advertiser.go`、`server/internal/landiscovery/browse.go`
- Modify: `server/go.mod`（加 `github.com/libp2p/zeroconf/v2 v2.2.0`）、`server/cmd/server/main.go`（启动后开始广播、退出前停止）、`server/cmd/server/router.go`（信任代理与 `handler.Config` 新字段）、`server/internal/handler/handler.go`（`Config` 增 `ServerName`、`InstanceID`）、`server/internal/handler/config.go`（`AppConfig` 增字段）、`apps/web/proxy.ts`（转发时带 `x-forwarded-host`）、`.env.example`
- Test: `server/internal/handler/config_test.go`、`server/cmd/server/router_test.go`（或现有同类测试文件）、`apps/web/proxy.test.ts`

**Interfaces:**
- Consumes: Task 1 的全部导出。
- Produces:
  - `type Entry struct { Instance, Name, ServerVersion, InstanceID, Host string; Port int; IPs []net.IP }`
  - `func Browse(ctx context.Context, timeout time.Duration) ([]Entry, error)`
  - `type Advertiser struct{...}`；`func Start(ctx context.Context, cfg Config, serverVersion, instanceID string) (*Advertiser, error)`；`func (a *Advertiser) Hostname() string`；`func (a *Advertiser) Stop()`
  - `/api/config` 新字段 `server_name`、`instance_id`（`omitempty`）
  - `func effectiveTrustedProxies(raw string, lanEnabled bool) []netip.Prefix`（`router.go`）

- [ ] **Step 1: 写失败的测试**

```go
// config_test.go
func TestGetConfigIncludesLANIdentity(t *testing.T) {
	h := newTestHandler(t, handler.Config{ServerName: "设计部 Marvis", InstanceID: "7f3a"})
	body := getConfigJSON(t, h)
	require.Equal(t, "设计部 Marvis", body["server_name"])
	require.Equal(t, "7f3a", body["instance_id"])
}

// router 测试
func TestEffectiveTrustedProxies(t *testing.T) {
	require.Empty(t, effectiveTrustedProxies("", false))
	require.ElementsMatch(t, []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32"), netip.MustParsePrefix("::1/128")},
		effectiveTrustedProxies("", true))
	require.Equal(t, []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}, effectiveTrustedProxies("10.0.0.0/8", true))
}
```

```ts
// proxy.test.ts
it("forwards the client host to the backend so same-origin checks see marvis.local", () => {
  process.env.REMOTE_API_URL = "http://localhost:13840";
  const res = proxy(new NextRequest("http://marvis.local:3000/api/me", { headers: { host: "marvis.local:3000" } }));
  expect(res.headers.get("x-middleware-request-x-forwarded-host")).toBe("marvis.local:3000");
});
```

`newTestHandler` / `getConfigJSON` 用 `config_test.go` 里现有的构造方式。

- [ ] **Step 2: 运行确认失败**

Run: `cd server && go test ./internal/handler/ -run TestGetConfigIncludesLANIdentity && go test ./cmd/server/ -run TestEffectiveTrustedProxies`；`pnpm --filter @marvis/web exec vitest run proxy.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

- `Start`：用 `zeroconf.RegisterProxy(cfg.Name, ServiceType, Domain, cfg.Port, host, ips, TXTRecords(...), nil)`；`host` 由 `ChooseHostname` 决定，`taken` 来自先 `Browse(ctx, 2*time.Second)` 拿到的其他实例（`InstanceID` 不等于自己的）的 `Host`；`ips` 由 `AdvertiseIPs` 基于 `net.Interfaces()` 计算。启动后 `slog.Info("lan discovery started", "host", host+".local", "port", cfg.Port)`。
- `main.go`：数据库就绪、`srv` 开始监听后，若 `cfg.Enabled`，`LoadInstanceID` 后调用 `Start`；`Start` 失败只记 `slog.Warn`，不阻止服务端启动；收到退出信号后在 `srv.Shutdown` 之前 `Stop()`。`ServerName`、`InstanceID` 写入 `handler.Config`。
- `effectiveTrustedProxies`：`raw` 非空时按原 `parseTrustedProxies` 解析；为空且 `lanEnabled` 时返回回环两段；否则空。替换 `router.go` 里 `TrustedProxies: parseTrustedProxies(...)` 的调用。这样本机网页端转发来的 `X-Forwarded-Host` 被 `realtime.checkOrigin` 接受，WebSocket 能从 `marvis.local:3000` 建立。
- `proxy.ts`：`runtimeDestination` 分支里复制请求头，在没有 `x-forwarded-host` 时设为 `req.headers.get("host")`，用 `NextResponse.rewrite(url, { request: { headers } })`。
- `.env.example`：在 Google 配置附近加 `MARVIS_LAN_DISCOVERY=`、`MARVIS_LAN_NAME=` 两行英文说明（Docker 部署不支持广播）。

- [ ] **Step 4: 运行确认通过，并手工验证广播**

Run: 同 Step 2，加 `cd server && golangci-lint run --new-from-rev=HEAD ./internal/landiscovery/ ./internal/handler/ ./cmd/server/`
Expected: PASS，0 issues

手工：`make start` 启动后执行 `dns-sd -B _marvis._tcp local`，应在 5 秒内看到一条 `Add`，实例名是服务器名称；`dns-sd -G v4 marvis.local` 返回本机局域网 IP；`curl -s http://marvis.local:13840/api/config | jq '.server_name,.instance_id'` 有值（端口为后端端口）。

- [ ] **Step 5: Commit**

```bash
git add server apps/web/proxy.ts apps/web/proxy.test.ts .env.example
git commit -m "feat(server): advertise on the LAN and expose server identity"
```

---

### Task 3: 桌面端地址规范、探测、保存与启动配置

**Files:**
- Create: `apps/desktop/src/shared/server-discovery.ts`、`apps/desktop/src/main/server-probe.ts`、`apps/desktop/src/main/server-selection.ts`
- Modify: `apps/desktop/src/shared/runtime-config.ts`（删除内置 `api.marvis.ai` 默认；结果增加未配置分支）、`apps/desktop/src/main/runtime-config-loader.ts`（读取顺序）
- Test: `apps/desktop/src/shared/server-discovery.test.ts`、`apps/desktop/src/main/server-probe.test.ts`、`apps/desktop/src/main/server-selection.test.ts`、`apps/desktop/src/main/runtime-config-loader.test.ts`

**Interfaces:**
- Produces（`shared/server-discovery.ts`）：

```ts
export const DEFAULT_SERVER_ADDRESS = "http://marvis.local:13840";
export interface ServerIdentity { url: string; name: string; version: string; instanceId: string; host: string; appUrl: string }  // appUrl 为空串表示没有网页端
export type ProbeResult =
  | { kind: "ok"; server: ServerIdentity }
  | { kind: "unreachable" }
  | { kind: "not_marvis" }
  | { kind: "too_old" };
export interface SelectedServer { url: string; name: string; instanceId: string; source: "lan" | "manual"; appUrl: string }
export function normalizeServerAddress(input: string): string | null;
```

- `main/server-probe.ts`：`probeServer(url: string, fetchImpl?: typeof fetch): Promise<ProbeResult>`（超时 3000ms）
- `main/server-selection.ts`：`readSelectedServer(userDataDir: string): Promise<SelectedServer | null>`、`writeSelectedServer(userDataDir: string, s: SelectedServer): Promise<void>`
- `RuntimeConfigResult` 增加 `{ ok: false; unconfigured: true }`；`runtimeConfigFromServer(s: SelectedServer): RuntimeConfig`（`apiUrl = s.url`，`appUrl = s.appUrl`（可为空串），`wsUrl` 由 `deriveWsUrl` 得出）
- `loadRuntimeConfig` 增参 `userDataDir: string`；顺序：开发模式且设置了 `VITE_API_URL` → 环境变量；`server.json` → 用它；`~/.marvis/desktop.json` → 用它；否则未配置。

- [ ] **Step 1: 写失败的测试**

```ts
describe("normalizeServerAddress", () => {
  it.each([
    ["192.168.1.20:3000", "http://192.168.1.20:3000"],
    ["marvis.local:3000/", "http://marvis.local:3000"],
    ["http://marvis.local:3000/login?x=1", "http://marvis.local:3000"],
    ["https://m.example.com", "https://m.example.com"],
  ])("%s -> %s", (input, expected) => expect(normalizeServerAddress(input)).toBe(expected));
  it.each(["", "   ", "ftp://x", "http://"])("rejects %s", (input) => expect(normalizeServerAddress(input)).toBeNull());
});

describe("probeServer", () => {
  const json = (body: unknown) => async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  it("ok", async () => expect(await probeServer("http://m:3000", json({ server_name: "设计部 Marvis", server_version: "v0.6.5", instance_id: "7f3a", daemon_app_url: "http://localhost:3000" }))).toEqual({ kind: "ok", server: { url: "http://m:3000", name: "设计部 Marvis", version: "v0.6.5", instanceId: "7f3a", host: "m", appUrl: "" } }));
  it("keeps a non-loopback app url", async () => expect((await probeServer("http://m:13840", json({ server_name: "a", instance_id: "b", daemon_app_url: "http://marvis.local:3000" }))) ).toMatchObject({ kind: "ok", server: { appUrl: "http://marvis.local:3000" } }));
  it("too_old", async () => expect((await probeServer("http://m:3000", json({ allow_signup: true }))).kind).toBe("too_old"));
  it("not_marvis on html", async () => expect((await probeServer("http://m:3000", async () => new Response("<html>", { headers: { "content-type": "text/html" } }))).kind).toBe("not_marvis"));
  it("not_marvis on 404", async () => expect((await probeServer("http://m:3000", async () => new Response("", { status: 404 }))).kind).toBe("not_marvis"));
  it("unreachable", async () => expect((await probeServer("http://m:3000", async () => { throw new TypeError("fetch failed"); })).kind).toBe("unreachable"));
});

it("prefers server.json over desktop.json and reports unconfigured when neither exists", async () => { /* 用临时目录分别验证三种情况 */ });
```

最后一个用例要断言：两份文件都在时 `apiUrl` 来自 `server.json`；都不在时结果为 `{ ok: false, unconfigured: true }`；`server.json` 写入后再读出相同对象。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @marvis/desktop exec vitest run src/shared/server-discovery.test.ts src/main/server-probe.test.ts src/main/server-selection.test.ts src/main/runtime-config-loader.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现上述接口**，并把 `DEFAULT_RUNTIME_CONFIG` 及其引用删除。名称为空时用 host 作名称。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2，加 `pnpm --filter @marvis/desktop typecheck`
Expected: PASS（`App.tsx` 对新分支的处理放在 Task 5，这里先让类型通过：未配置分支暂时走 `BlockingRuntimeConfigError` 之外的空渲染即可）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared apps/desktop/src/main
git commit -m "feat(desktop): probe, save, and load the selected server"
```

---

### Task 4: 桌面端局域网浏览与 IPC

**Files:**
- Create: `apps/desktop/src/main/lan-browser.ts`、`apps/desktop/src/main/server-ipc.ts`
- Modify: `apps/desktop/package.json`（加 `bonjour-service@1.3.0`）、`apps/desktop/src/main/index.ts`（注册 IPC）、`apps/desktop/src/preload/index.ts`、`apps/desktop/src/preload/index.d.ts`
- Test: `apps/desktop/src/main/lan-browser.test.ts`、`apps/desktop/src/main/server-ipc.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `probeServer`、`ServerIdentity`、`SelectedServer`、`writeSelectedServer`、`runtimeConfigFromServer`。
- Produces:
  - `interface DiscoveredServer extends ServerIdentity { isLocal: boolean; compatible: boolean }`（放 `shared/server-discovery.ts`）
  - `createLanBrowser(deps: { browse: (onUp: (svc: MdnsService) => void, onDown: (svc: MdnsService) => void) => () => void; probe: typeof probeServer; localAddresses: () => string[] }): { start(onChange: (list: DiscoveredServer[]) => void): void; stop(): void; rescan(): void }`
  - `type ServerStatus = { state: "online" } | { state: "reconnecting" } | { state: "unreachable" } | { state: "moved"; url: string } | { state: "replaced"; otherName: string }`（放 `shared/server-discovery.ts`，Task 7 负责产生这些状态）
  - preload `window.desktopAPI.server`：`discover(onChange: (list: DiscoveredServer[]) => void): () => void`、`rescan(): void`、`probe(url: string): Promise<ProbeResult>`、`current(): Promise<SelectedServer | null>`、`select(s: SelectedServer): Promise<void>`、`onStatus(cb: (s: ServerStatus) => void): () => void`、`retry(): void`
  - IPC 通道常量：`SERVER_DISCOVER = "server:discover"`、`SERVER_DISCOVERED = "server:discovered"`、`SERVER_RESCAN = "server:rescan"`、`SERVER_PROBE = "server:probe"`、`SERVER_CURRENT = "server:current"`、`SERVER_SELECT = "server:select"`、`SERVER_STATUS = "server:status"`

- [ ] **Step 1: 写失败的测试**

```ts
it("dedupes by instanceId and probes new services concurrently", async () => {
  // 两个通告属于同一实例（两个 IP），一个是另一实例；probe 桩按 URL 返回身份
  // 断言：onChange 最终收到 2 条；probe 对 3 个 URL 各调用一次；三次调用在任一 resolve 之前都已发出
});
it("marks servers on this machine as isLocal and incompatible ones as compatible=false", async () => { /* too_old -> compatible:false */ });
it("removes a server when its last address goes down", async () => { /* onDown 后列表减少 */ });
it("select writes server.json and reloads windows", async () => { /* server-ipc：注入 write 与 reloadAll 桩，断言调用参数 */ });
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @marvis/desktop exec vitest run src/main/lan-browser.test.ts src/main/server-ipc.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`lan-browser.ts` 生产实现用 `new Bonjour().find({ type: "marvis" }, onUp)` 并监听 `down`；URL 用 `http://<host>:<port>`，`host` 取通告里的主机名（如 `marvis.local`），不用 IP。`server-ipc.ts` 的 `select` 写 `server.json` 后，更新主进程持有的 `runtimeConfigResult` 并对所有窗口 `webContents.reload()`。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2，加 `pnpm --filter @marvis/desktop typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/main apps/desktop/src/preload apps/desktop/src/shared
git commit -m "feat(desktop): browse the LAN for Marvis servers"
```

---

### Task 5: 连接服务器页（设计稿 20）

**Files:**
- Create: `apps/desktop/src/renderer/src/components/server/connect-server-screen.tsx`、`.../server/server-address-field.tsx`、`.../server/use-lan-servers.ts`
- Modify: `apps/desktop/src/renderer/src/App.tsx`（未配置时渲染连接页，外层包 `I18nProvider`）、五种语言 `packages/views/locales/*/settings.json`
- Test: `apps/desktop/src/renderer/src/components/server/connect-server-screen.test.tsx`

**Interfaces:**
- Consumes: Task 4 的 `window.desktopAPI.server`；Task 3 的 `normalizeServerAddress`、`DEFAULT_SERVER_ADDRESS`。
- Produces:
  - `useLanServers(): { servers: DiscoveredServer[]; scanning: boolean; rescan(): void }`（订阅 5 秒内 `scanning` 为 true）
  - `<ServerAddressField value onChange onResult />`：输入框 + “测试连接”；`onResult(result: ProbeResult | null)`
  - `<ConnectServerScreen />`

- [ ] **Step 1: 写失败的测试**

```tsx
it("lists discovered servers, disables incompatible ones, and continues to the confirm step", async () => {
  // 桩：两个兼容 + 一个 compatible:false
  // 断言：三行可见、第三行 disabled、默认选中第一行、点“继续”后出现“连接到 设计部 Marvis？”
});
it("pre-fills the address field and only enables continue after a successful test", async () => {
  // 选中地址栏 -> 继续按钮禁用；probe 返回 ok -> 出现“可以连接 · 设计部 Marvis · v0.6.5”，继续可用
});
it("shows the not-found note and selects the address field when nothing is discovered", async () => { /* scanning 结束、列表为空 */ });
it("shows the HTTP warning on the confirm step and calls select on connect", async () => { /* 断言 select 参数 source 为 'lan' */ });
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @marvis/desktop exec vitest run src/renderer/src/components/server/connect-server-screen.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**，版式照设计稿 20（卡片 480 宽、24 圆角；行 58 高；输入框预填 `DEFAULT_SERVER_ADDRESS`；测试失败时输入框描边变红）。补全文案表中 `connect.*`、`address.*`、`probe.*`、`confirm.*` 五种语言。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2，加 `pnpm --filter @marvis/desktop typecheck`、`pnpm --filter @marvis/views exec vitest run locales`、`pnpm check:ui-radii`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer packages/views/locales
git commit -m "feat(desktop): connect-to-server screen on first launch"
```

---

### Task 6: 设置 · 服务器（设计稿 21）

**Files:**
- Create: `apps/desktop/src/renderer/src/components/server/server-settings-tab.tsx`
- Modify: `apps/desktop/src/renderer/src/routes.tsx`（`extraDeviceTabs` 首位加 `{ value: "server", label: t(($) => $.desktop.server.tab_label), icon: Server, content: <ServerSettingsTab /> }`，原守护进程图标换成 `Cpu` 以免重复）、五种语言 `settings.json`
- Test: `apps/desktop/src/renderer/src/components/server/server-settings-tab.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 `useLanServers`、`ServerAddressField`；Task 4 的 `current`、`select`；现有退出登录 `tearDownOnLogout`（`apps/desktop/src/renderer/src/App.tsx` 的 `handleDaemonLogout`，抽成可导入的函数）。

- [ ] **Step 1: 写失败的测试**

```tsx
it("shows the current server and hides it from the LAN list", async () => { /* current 的 instanceId 不出现在列表 */ });
it("asks before switching, then logs out and selects", async () => {
  // 点某行“切换” -> 出现“切换到 marvis-dev？”；点确认 -> logout 先于 select 调用
});
it("enables the manual switch only after a successful test", async () => { /* 同 Task 5 的地址栏行为 */ });
```

- [ ] **Step 2–4:** 运行失败 → 实现（版式照设计稿 21：当前服务器卡片用 `bg-surface-sunken`；列表行 56 高、细分隔线；“其他地址”一行三个控件）→ 运行通过（同 Task 5 的命令集）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer packages/views/locales
git commit -m "feat(desktop): server settings tab"
```

---

### Task 7: 掉线监测与恢复（设计稿 23）

**Files:**
- Create: `apps/desktop/src/main/server-watch.ts`、`apps/desktop/src/renderer/src/components/server/server-status-banner.tsx`
- Modify: `apps/desktop/src/main/index.ts`（主窗口就绪后启动监测，`retry` IPC 调 `retryNow`）、`apps/desktop/src/renderer/src/components/desktop-layout.tsx`（主卡片顶部挂横幅、弹窗与提示）、五种语言 `settings.json`
- Test: `apps/desktop/src/main/server-watch.test.ts`、`apps/desktop/src/renderer/src/components/server/server-status-banner.test.tsx`

**Interfaces:**
- Consumes: Task 3 `probeServer`、`writeSelectedServer`；Task 4 `createLanBrowser`、`ServerStatus`、`SERVER_STATUS`、preload 的 `retry()`。
- Produces:

```ts
export function createServerWatch(deps: {
  selected: SelectedServer; probe: typeof probeServer; discovered: () => DiscoveredServer[];
  save: (s: SelectedServer) => Promise<void>; emit: (s: ServerStatus) => void; now?: () => number;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
}): { start(): void; stop(): void; retryNow(): void };
```

间隔：在线时每 10 秒探测一次；失败后切到 `reconnecting`、每 3 秒一次；连续 3 次失败切到 `unreachable`，之后每 15 秒一次。

- [ ] **Step 1: 写失败的测试**

```ts
describe("server watch transitions", () => {
  it("online -> reconnecting -> unreachable -> online with fake timers", async () => { /* 断言 emit 顺序与计时 */ });
  it("follows the same instance to a new address and saves it", async () => {
    // probe 原地址失败；discovered 里出现同 instanceId 的新 url -> save 新地址，emit { state: "moved", url }
  });
  it("does not switch when another instance answers at the saved address", async () => {
    // probe 原地址返回不同 instanceId -> emit { state: "replaced", otherName }，save 未被调用
  });
  it("emits each state once, not on every failed probe", async () => { /* 连续失败期间 reconnecting 只发一次 */ });
});
```

- [ ] **Step 2–4:** 运行失败 → 实现（横幅、提示、弹窗按设计稿 23；`retryNow` 绑“重试”；“切换服务器”打开设置的服务器页）→ 运行通过（`pnpm --filter @marvis/desktop exec vitest run src/main/server-watch.test.ts src/renderer/src/components/server`、typecheck）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src packages/views/locales
git commit -m "feat(desktop): detect server outages and follow moved servers"
```

---

### Task 10: 没有网页端时的桌面端

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/login.tsx`（`appUrl` 为空时不传 `onGoogleLogin`、`onLarkLogin`，登录页只剩邮箱验证码）、`apps/desktop/src/renderer/src/platform/navigation.tsx`（`appUrl` 为空时 `getShareableUrl(path)` 返回 `marvis://open?path=<encodeURIComponent(path)>`）、`apps/desktop/src/renderer/src/platform/issue-window-navigation.tsx`（打开网页端的入口在 `appUrl` 为空时不显示或不执行）、`apps/desktop/src/main/index.ts`（`handleDeepLink` 支持 `marvis://open?path=...`，只接受以 `/` 开头的站内路径，派发给主窗口导航）、对应渲染进程监听
- Test: 上述文件同目录的测试

**Interfaces:**
- Consumes: Task 3 的 `RuntimeConfig.appUrl`（空串表示没有网页端）。
- Produces: 深链格式 `marvis://open?path=<站内路径>`。

- [ ] **Step 1: 写失败的测试**
  - `getShareableUrl("/dev/issues/DEV-1")` 在 `appUrl` 为空时返回 `marvis://open?path=%2Fdev%2Fissues%2FDEV-1`，有 `appUrl` 时返回 `${appUrl}/dev/issues/DEV-1`。
  - 深链解析：`marvis://open?path=%2Fdev%2Fissues%2FDEV-1` 派发路径 `/dev/issues/DEV-1`；`path` 不以 `/` 开头、或为 `//evil.com` 这类协议相对地址时忽略。
  - 登录页：`appUrl` 为空时不渲染 Google、飞书按钮；有 `appUrl` 时与现在一致。
  - 依赖 `getShareableUrl` 的站内行为（如在新标签打开、`app-link` 的 `openInNewTab`）在桌面端仍走站内导航，不被深链影响（为它们各写一条断言）。
- [ ] **Step 2–4:** 运行失败 → 实现（不改 `packages/views` 里的 13 处调用方）→ 运行通过（desktop vitest、typecheck）
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(desktop): work without a web app"
```

---

### Task 8: 命令行选择服务器（设计稿 22）

**Files:**
- Create: `server/cmd/marvis/setup_discover.go`、`server/internal/cli/desktop_server.go`
- Modify: `server/cmd/marvis/cmd_setup.go`（`runSetupSelfHost`：未提供服务器地址、且标准输入是终端时，先走选择流程）
- Test: `server/cmd/marvis/setup_discover_test.go`、`server/internal/cli/desktop_server_test.go`

**Interfaces:**
- Consumes: Task 2 `landiscovery.Browse`、`landiscovery.Entry`。
- Produces:
  - `func ReadDesktopSelectedServer(configDir string) (DesktopServer, bool)`；`type DesktopServer struct { URL, Name, InstanceID string }`；路径 `filepath.Join(configDir, "Marvis", "server.json")`，生产调用传 `os.UserConfigDir()` 的结果
  - `type candidate struct { URL, Name, ServerVersion, InstanceID string; FromDesktop bool }`
  - `func mergeCandidates(desktop *DesktopServer, found []landiscovery.Entry) []candidate`
  - `func pickServer(in io.Reader, out io.Writer, cands []candidate, probe func(string) bool) (string, error)`

- [ ] **Step 1: 写失败的测试**

```go
func TestMergeCandidates(t *testing.T) {
	desktop := &cli.DesktopServer{URL: "http://marvis.local:13840", Name: "设计部 Marvis", InstanceID: "a"}
	found := []landiscovery.Entry{
		{Name: "marvis-dev", Host: "marvis-2.local.", Port: 13840, InstanceID: "b"},
		{Name: "设计部 Marvis", Host: "marvis.local.", Port: 13840, InstanceID: "a"},
		{Name: "设计部 Marvis", Host: "marvis.local.", Port: 13840, InstanceID: "a"},
	}
	got := mergeCandidates(desktop, found)
	require.Len(t, got, 2)
	require.True(t, got[0].FromDesktop)
	require.Equal(t, "http://marvis.local:13840", got[0].URL)
	require.Equal(t, "http://marvis-2.local:13840", got[1].URL)
}

func TestPickServerDefaultsToFirstAndAcceptsManualAddress(t *testing.T) {
	cands := []candidate{{URL: "http://marvis.local:13840", Name: "设计部 Marvis", FromDesktop: true}}
	url, err := pickServer(strings.NewReader("\n"), io.Discard, cands, func(string) bool { return true })
	require.NoError(t, err)
	require.Equal(t, "http://marvis.local:13840", url)

	url, err = pickServer(strings.NewReader("2\nhttp://192.168.1.58:13840\n"), io.Discard, cands, func(string) bool { return true })
	require.NoError(t, err)
	require.Equal(t, "http://192.168.1.58:13840", url)
}

func TestReadDesktopSelectedServer(t *testing.T) { /* 临时目录写 Marvis/server.json，读出相同字段；不存在时 ok=false */ }
```

- [ ] **Step 2–4:** 运行失败（`cd server && go test ./cmd/marvis/ -run 'MergeCandidates|PickServer' ./internal/cli/ -run ReadDesktop`）→ 实现 → 运行通过并 `golangci-lint run --new-from-rev=HEAD ./cmd/marvis/ ./internal/cli/` 零告警

实现要点：列表用数字序号，最后一项为 “Enter an address manually”，默认值 `http://marvis.local:13840`；手动地址先 `probeServer` 再接受；选中后 `serverURL` 设为该地址；`appURL` 取该服务器 `/api/config` 的 `daemon_app_url`（非回环才用）。有网页地址时继续走现有的确认覆盖、可达性探测与浏览器登录流程；没有时保存配置后提示 “No web app is configured for this server. Log in with `marvis login --token` using a token from Marvis Desktop → Settings → API Token.”，不打开浏览器。非终端或已传 `--server-url` / `MARVIS_SERVER_URL` 时不进入此流程。输出文字用英文，与现有命令行一致，例如 “Desktop is using: 设计部 Marvis”、“Looking for Marvis servers on the local network… found 2”。

- [ ] **Step 5: Commit**

```bash
git add server/cmd/marvis server/internal/cli
git commit -m "feat(cli): pick a LAN server in setup self-host"
```

---

### Task 9: 文档与端到端手工验证

**Files:**
- Modify: `apps/docs/content/docs/desktop-app.mdx`、`desktop-app.zh.mdx`、`desktop-app.fr.mdx`（新增“连接服务器”一节，说明首次启动的连接页、设置里的服务器页，`~/.marvis/desktop.json` 仍可用作预置）、`apps/docs/content/docs/self-host-quickstart.mdx`（及同名译文）（新增“局域网发现”一节：源码运行时默认开启，Docker 部署不支持，`MARVIS_LAN_DISCOVERY` / `MARVIS_LAN_NAME`）

- [ ] **Step 1: 改文档**
- [ ] **Step 2: 手工验证**（服务器 Mac `make start`；另一台电脑同一 Wi-Fi）
  - 只启动后端和数据库（不启动网页端）：桌面端发现并连上，邮箱验证码登录，不显示 Google/飞书按钮；“复制链接”得到 `marvis://open?...`，在另一台装了桌面端的电脑上能打开。
  - 再启动网页端并配置 `MARVIS_APP_URL=http://marvis.local:3000`：浏览器打开它并完成登录，页面实时更新正常（WebSocket 已连上）；桌面端重新连接后出现 Google/飞书按钮。
  - 新装桌面端打开即出现连接页，列表中有该服务器；连接、登录后本地守护进程在线。
  - 设置 · 服务器切到另一台再切回，均需重新登录。
  - 停止服务端：桌面端 10 秒内出现“正在重新连接”，约 20 秒后变为“无法连接”；重启服务端后自动回到在线。
  - 服务器 Mac 换 IP（切换网络）：桌面端自动跟随并提示“已重新连接”。
  - 终端执行 `marvis setup self-host`，第一项为“桌面端正在使用”的服务器，回车完成登录。
- [ ] **Step 3: Commit**

```bash
git add apps/docs
git commit -m "docs: connecting to a server and LAN discovery"
```
