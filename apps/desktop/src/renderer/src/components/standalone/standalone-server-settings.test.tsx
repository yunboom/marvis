import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@marvis/core/i18n/react";
import { RESOURCES } from "@marvis/views/locales";
import { NavigationProvider, type NavigationAdapter } from "@marvis/views/navigation";
import {
  SERVER_SOURCE_STANDALONE,
  type ProbeResult,
  type ServerIdentity,
} from "../../../../shared/server-discovery";
import {
  INTEGRATION_KEY_ENVS,
  defaultStandaloneSettings,
  type StandaloneBackup,
  type StandaloneConfigView,
  type StandaloneSetupInput,
  type StandaloneStatus,
} from "../../../../shared/standalone";
import { PROBE_MIN_DISPLAY_MS } from "../server/server-address-field";

const DAY_MS = 24 * 60 * 60 * 1000;

const mocks = vi.hoisted(() => ({
  restart: vi.fn(),
  stop: vi.fn(),
  retry: vi.fn(),
  setLan: vi.fn(),
  config: vi.fn(),
  saveSettings: vi.fn(),
  listBackups: vi.fn(),
  backupNow: vi.fn(),
  restoreBackup: vi.fn(),
  openDataDir: vi.fn(),
  openLogs: vi.fn(),
  switchRemote: vi.fn(),
  probe: vi.fn(),
  daemonLogout: vi.fn(),
  clearClientSessionData: vi.fn(),
  authLogout: vi.fn(),
  toastError: vi.fn(),
  calls: [] as string[],
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

vi.mock("../../platform/desktop-session-teardown", () => ({
  handleDaemonLogout: mocks.daemonLogout,
}));

vi.mock("@marvis/core/auth", () => ({
  useAuthStore: (selector: (state: { logout: () => void }) => unknown) =>
    selector({ logout: mocks.authLogout }),
}));

vi.mock("@marvis/core/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@marvis/core/platform")>()),
  clearClientSessionData: mocks.clearClientSessionData,
}));

const { ServerSettingsTab } = await import("../server/server-settings-tab");

let pushStatus: (status: StandaloneStatus) => void = () => {};

function status(overrides: Partial<StandaloneStatus> = {}): StandaloneStatus {
  return {
    phase: "running",
    version: "0.6.5",
    progress: null,
    error: null,
    lanUrl: null,
    localUrl: "http://127.0.0.1:13840",
    startedAt: new Date(Date.now() - 3 * DAY_MS - 60_000).toISOString(),
    update: { state: "latest", availableVersion: null, sizeBytes: null, progress: null, checkedAt: null },
    ...overrides,
  };
}

function configView(overrides: Partial<StandaloneConfigView> = {}): StandaloneConfigView {
  const settings = defaultStandaloneSettings("DJ-mayunpeng 的 Marvis");
  settings.adminEmail = "admin@example.com";
  settings.lark = { appId: "cli_abc", tenantKeys: "" };

  return {
    settings,
    locked: true,
    loginCode: "888888",
    hasLarkAppSecret: true,
    hasSmtpPassword: false,
    hasLlmApiKey: false,
    ...overrides,
  };
}

const backups: StandaloneBackup[] = [
  {
    fileName: "backup-update.tar",
    createdAt: "2026-10-20T12:00:00.000Z",
    version: "0.6.4",
    sizeBytes: 1.1 * 1024 * 1024 * 1024,
    reason: "update",
  },
  {
    fileName: "backup-manual.tar",
    createdAt: "2026-10-12T12:00:00.000Z",
    version: "0.6.4",
    sizeBytes: 900 * 1024 * 1024,
    reason: "manual",
  },
];

const devServer: ServerIdentity = {
  url: "http://192.168.1.37:13840",
  name: "marvis-dev",
  version: "v0.6.5",
  instanceId: "inst-dev",
  host: "marvis-dev.local",
  appUrl: "http://192.168.1.37:3000",
};

const navigation: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/settings",
  searchParams: new URLSearchParams("tab=server"),
  hash: "",
  getShareableUrl: (path) => path,
};

let currentStatus: StandaloneStatus = status();

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function") mock.mockReset();
  }
  mocks.calls.length = 0;
  currentStatus = status();

  mocks.config.mockResolvedValue(configView());
  mocks.listBackups.mockResolvedValue(backups);
  mocks.saveSettings.mockResolvedValue({ ok: true });
  for (const name of ["restart", "stop", "retry", "setLan", "backupNow", "restoreBackup", "openDataDir", "openLogs"] as const) {
    mocks[name].mockResolvedValue(undefined);
  }
  mocks.probe.mockResolvedValue({ kind: "unreachable" } satisfies ProbeResult);
  mocks.daemonLogout.mockImplementation(async () => {
    mocks.calls.push("teardown");
  });
  mocks.authLogout.mockImplementation(() => {
    mocks.calls.push("logout");
  });
  mocks.switchRemote.mockImplementation(async () => {
    mocks.calls.push("switch");
  });

  Object.defineProperty(window, "desktopAPI", {
    configurable: true,
    value: {
      appInfo: { version: "0.6.5", os: "macos" },
      server: {
        current: async () => ({
          url: "http://127.0.0.1:13840",
          name: "DJ-mayunpeng 的 Marvis",
          instanceId: "local",
          source: SERVER_SOURCE_STANDALONE,
          appUrl: "",
        }),
        probe: mocks.probe,
      },
      standalone: {
        onStatus: (callback: (next: StandaloneStatus) => void) => {
          pushStatus = callback;
          callback(currentStatus);
          return () => {};
        },
        config: mocks.config,
        saveSettings: mocks.saveSettings,
        restart: mocks.restart,
        stop: mocks.stop,
        retry: mocks.retry,
        setLan: mocks.setLan,
        listBackups: mocks.listBackups,
        backupNow: mocks.backupNow,
        restoreBackup: mocks.restoreBackup,
        openDataDir: mocks.openDataDir,
        openLogs: mocks.openLogs,
        switchRemote: mocks.switchRemote,
      },
    },
  });
});

async function renderTab() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider locale="zh-Hans" resources={RESOURCES}>
        <NavigationProvider value={navigation}>
          <ServerSettingsTab />
        </NavigationProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

  await screen.findByText("DJ-mayunpeng 的 Marvis");
}

function statusCard(): HTMLElement {
  return screen.getByRole("region", { name: "DJ-mayunpeng 的 Marvis" });
}

describe("StandaloneServerSettings status", () => {
  it("shows the name, resource version, uptime and running actions", async () => {
    await renderTab();

    expect(screen.getByText("这台电脑处于单机模式。")).toBeInTheDocument();
    const card = statusCard();
    expect(card).toHaveTextContent("单机模式");
    expect(card).toHaveTextContent("资源版本 v0.6.5 · 已运行 3 天");
    expect(within(card).getByRole("status")).toHaveTextContent("运行中");

    fireEvent.click(within(card).getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(1));

    fireEvent.click(within(card).getByRole("button", { name: "停止" }));
    await waitFor(() => expect(mocks.stop).toHaveBeenCalledTimes(1));
  });

  it("offers start when stopped", async () => {
    currentStatus = status({ phase: "stopped", startedAt: null });
    await renderTab();

    const card = statusCard();
    expect(card).toHaveTextContent("资源版本 v0.6.5");
    expect(card).not.toHaveTextContent("已运行");
    expect(within(card).getByRole("status")).toHaveTextContent("已停止");
    expect(within(card).getByRole("button", { name: "重新加载" })).toBeDisabled();

    fireEvent.click(within(card).getByRole("button", { name: "启动" }));
    await waitFor(() => expect(mocks.retry).toHaveBeenCalledTimes(1));
  });

  it("shows updating while a resource update installs", async () => {
    await renderTab();

    act(() =>
      pushStatus(status({ update: { state: "installing", availableVersion: "0.6.6", sizeBytes: null, progress: null, checkedAt: null } })),
    );

    expect(within(statusCard()).getByRole("status")).toHaveTextContent("正在更新");
  });

  it("links resource updates to the updates tab", async () => {
    await renderTab();

    expect(screen.getByRole("link", { name: "前往" })).toHaveAttribute("href", "/acme/settings?tab=updates");
  });
});

describe("StandaloneServerSettings LAN", () => {
  it("turns LAN on through setLan and only explains the address while on", async () => {
    await renderTab();

    expect(screen.queryByRole("button", { name: "允许局域网连接说明" })).not.toBeInTheDocument();

    const lanSwitch = screen.getByRole("switch", { name: "允许局域网连接" });
    mocks.config.mockResolvedValue(configView({ settings: { ...configView().settings, lanEnabled: true } }));
    fireEvent.click(lanSwitch);

    await waitFor(() => expect(mocks.setLan).toHaveBeenCalledWith(true));
    act(() => pushStatus(status({ lanUrl: "http://192.168.1.20:13840" })));

    const info = await screen.findByRole("button", { name: "允许局域网连接说明" });
    fireEvent.click(info);
    expect(
      await screen.findByText("局域网中的设备会自动发现这台电脑。搜索不到时，手动输入地址 http://192.168.1.20:13840"),
    ).toBeInTheDocument();
  });
});

describe("StandaloneServerSettings switch to another server", () => {
  it("enables switching only after a successful probe and switches after confirmation", async () => {
    await renderTab();

    const field = screen.getByRole("group", { name: "服务器地址" });
    const switchButton = within(field).getByRole("button", { name: "切换" });
    expect(switchButton).toBeDisabled();
    expect(screen.getByText("连接成功后单机模式停止，本机数据保留，之后可以在这里切回。")).toBeInTheDocument();

    fireEvent.change(within(field).getByRole("textbox"), { target: { value: devServer.url } });
    mocks.probe.mockResolvedValueOnce({ kind: "ok", server: devServer } satisfies ProbeResult);
    fireEvent.click(within(field).getByRole("button", { name: "测试连接" }));
    await act(() => new Promise((resolve) => setTimeout(resolve, PROBE_MIN_DISPLAY_MS)));

    expect(switchButton).toBeEnabled();
    fireEvent.click(switchButton);

    const dialog = await screen.findByRole("alertdialog", { name: "切换到 marvis-dev？" });
    expect(dialog).toHaveTextContent(
      "会退出当前账号，连接到 192.168.1.37:13840 后重新登录。单机模式随之停止，本机数据保留。",
    );
    expect(mocks.switchRemote).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "切换" }));

    await waitFor(() =>
      expect(mocks.switchRemote).toHaveBeenCalledWith({
        url: devServer.url,
        name: devServer.name,
        instanceId: devServer.instanceId,
        source: "manual",
        appUrl: devServer.appUrl,
      }),
    );
    expect(mocks.calls).toEqual(["teardown", "logout", "switch"]);
  });
});

describe("StandaloneServerSettings configuration", () => {
  it("summarizes the configuration", async () => {
    await renderTab();

    const section = screen.getByRole("region", { name: "配置" });
    expect(section).toHaveTextContent("端口13840");
    expect(section).toHaveTextContent("管理员邮箱admin@example.com");
    expect(section).toHaveTextContent("飞书登录已配置");
    expect(section).toHaveTextContent("邮件服务未配置");
    expect(section).toHaveTextContent("安全密钥已锁定");
  });

  it("edits with locked keys read-only, keeps saved secrets and maps save errors", async () => {
    mocks.saveSettings.mockResolvedValueOnce({ ok: false, errors: { "settings.port": "port_range" } });
    await renderTab();

    fireEvent.click(within(screen.getByRole("region", { name: "配置" })).getByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑配置" });
    expect(dialog).toHaveTextContent("保存后重新加载生效。");

    fireEvent.click(within(dialog).getByRole("button", { name: /安全密钥/ }));
    const jwt = within(dialog).getByLabelText("登录签名密钥");
    expect(jwt).toHaveAttribute("readonly");
    expect(within(dialog).queryByRole("button", { name: "随机生成登录签名密钥" })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1));
    const submitted = mocks.saveSettings.mock.calls[0][0] as StandaloneSetupInput;
    // 已锁定的密钥与未改动的已保存密钥都提交空串，由主进程保留原值。
    expect(submitted.secrets.jwtSecret).toBe("");
    expect(submitted.secrets.postgresPassword).toBe("");
    for (const env of INTEGRATION_KEY_ENVS) expect(submitted.secrets.integrationKeys[env]).toBe("");
    expect(submitted.secrets.larkAppSecret).toBe("");
    expect(submitted.secrets.loginCode).toBe("888888");
    expect(submitted.settings.lark.appId).toBe("cli_abc");

    // 主进程返回的字段错误显示在对应字段下，弹窗保持打开。
    expect(await within(dialog).findByText("端口范围 1024–65535")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "编辑配置" })).toBeInTheDocument();
  });

  it("closes and reloads the summary after saving", async () => {
    await renderTab();

    fireEvent.click(within(screen.getByRole("region", { name: "配置" })).getByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑配置" });
    mocks.config.mockResolvedValue(configView({ settings: { ...configView().settings, port: 14000 } }));

    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑配置" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("region", { name: "配置" })).toHaveTextContent("端口14000"));
  });
});

describe("StandaloneServerSettings data", () => {
  it("lists backups and restores only after confirmation", async () => {
    await renderTab();

    const section = screen.getByRole("region", { name: "数据" });
    expect(await within(section).findByText("更新前自动备份 · 10月20日")).toBeInTheDocument();
    expect(section).toHaveTextContent("1.1 GB");
    expect(section).toHaveTextContent("手动备份 · 10月12日");
    expect(section).toHaveTextContent("900.0 MB");
    expect(section).toHaveTextContent("保留最近 3 份备份");

    fireEvent.click(within(section).getAllByRole("button", { name: "恢复" })[0]);
    const dialog = await screen.findByRole("alertdialog", { name: "恢复到 10月20日 的备份？" });
    expect(dialog).toHaveTextContent("当前数据会被替换，局域网连接会短暂中断。");
    expect(mocks.restoreBackup).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "恢复" }));

    await waitFor(() => expect(mocks.restoreBackup).toHaveBeenCalledWith("backup-update.tar"));
  });

  it("backs up now, opens the data folder and the logs", async () => {
    await renderTab();

    const section = screen.getByRole("region", { name: "数据" });
    fireEvent.click(within(section).getByRole("button", { name: "立即备份" }));
    await waitFor(() => expect(mocks.backupNow).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.listBackups).toHaveBeenCalledTimes(2));

    fireEvent.click(within(section).getByRole("button", { name: "打开" }));
    fireEvent.click(within(section).getByRole("button", { name: "查看" }));
    expect(mocks.openDataDir).toHaveBeenCalledTimes(1);
    expect(mocks.openLogs).toHaveBeenCalledTimes(1);
  });
});
