import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@marvis/core/i18n/react";
import { RESOURCES } from "@marvis/views/locales";
import {
  DEFAULT_SERVER_ADDRESS,
  SERVER_SOURCE_LAN,
  SERVER_SOURCE_MANUAL,
  type DiscoveredServer,
  type ProbeResult,
  type SelectedServer,
} from "../../../../shared/server-discovery";
import { PROBE_MIN_DISPLAY_MS } from "./server-address-field";
import { LAN_SCAN_WINDOW_MS } from "./use-lan-servers";

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  rescan: vi.fn(),
  probe: vi.fn(),
  current: vi.fn(),
  select: vi.fn(),
  unsubscribe: vi.fn(),
  daemonLogout: vi.fn(),
  clearClientSessionData: vi.fn(),
  authLogout: vi.fn(),
  // 记录退出登录与保存选择的先后顺序。
  calls: [] as string[],
  toastError: vi.fn(),
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

const { ServerSettingsTab } = await import("./server-settings-tab");

function lanServer(overrides: Partial<DiscoveredServer> = {}): DiscoveredServer {
  return {
    url: "http://192.168.1.20:13840",
    name: "设计部 Marvis",
    version: "v0.6.5",
    instanceId: "inst-design",
    host: "design-mac-mini.local",
    appUrl: "http://192.168.1.20:3000",
    isLocal: false,
    compatible: true,
    ...overrides,
  };
}

const designServer = lanServer();
const devServer = lanServer({
  url: "http://192.168.1.37:13840",
  name: "marvis-dev",
  instanceId: "inst-dev",
  host: "marvis-dev.local",
  appUrl: "",
  isLocal: true,
});
const oldServer = lanServer({
  url: "http://192.168.1.58:13840",
  name: "测试环境",
  version: "v0.5.2",
  instanceId: "inst-old",
  host: "test-env.local",
  appUrl: "",
  compatible: false,
});

const savedDesign: SelectedServer = {
  url: designServer.url,
  name: designServer.name,
  instanceId: designServer.instanceId,
  source: SERVER_SOURCE_LAN,
  appUrl: designServer.appUrl,
};

// 触发主进程推送的发现列表。
let pushServers: (list: DiscoveredServer[]) => void = () => {};
// 按地址返回 probe 结果；没配置的地址视为连不上。
let probeResults: Record<string, ProbeResult> = {};

function installDesktopAPI(runtimeConfig: unknown) {
  mocks.calls.length = 0;
  probeResults = {};

  mocks.discover.mockReset().mockImplementation((onChange: (list: DiscoveredServer[]) => void) => {
    pushServers = onChange;
    return mocks.unsubscribe;
  });
  mocks.rescan.mockReset();
  mocks.probe
    .mockReset()
    .mockImplementation(async (url: string) => probeResults[url] ?? { kind: "unreachable" });
  mocks.current.mockReset().mockResolvedValue(savedDesign);
  mocks.select.mockReset().mockImplementation(async () => {
    mocks.calls.push("select");
  });
  mocks.unsubscribe.mockReset();
  mocks.daemonLogout.mockReset().mockImplementation(async () => {
    mocks.calls.push("teardown");
  });
  mocks.clearClientSessionData.mockReset().mockImplementation(() => {
    mocks.calls.push("clear");
  });
  mocks.authLogout.mockReset().mockImplementation(() => {
    mocks.calls.push("logout");
  });
  mocks.toastError.mockReset();

  Object.defineProperty(window, "desktopAPI", {
    configurable: true,
    value: {
      runtimeConfig,
      server: {
        discover: mocks.discover,
        rescan: mocks.rescan,
        probe: mocks.probe,
        current: mocks.current,
        select: mocks.select,
      },
    },
  });
}

function runtimeConfigFor(apiUrl: string) {
  return { ok: true, config: { schemaVersion: 1, apiUrl, wsUrl: "", appUrl: "" } };
}

function renderTab() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider locale="zh-Hans" resources={RESOURCES}>
        <ServerSettingsTab />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

// 等当前服务器和状态探测落地，再推送一份发现列表。
async function openTab(list: DiscoveredServer[] = []) {
  renderTab();
  await act(async () => {});
  act(() => pushServers(list));
}

function lanRows(): HTMLElement[] {
  return screen.queryAllByRole("listitem");
}

function manualSwitchButton(): HTMLElement {
  return within(screen.getByRole("group", { name: "服务器地址" })).getByRole("button", {
    name: "切换",
  });
}

async function runProbe(result: ProbeResult) {
  mocks.probe.mockResolvedValueOnce(result);
  fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
  // 等“正在测试”的最短显示时长过去，结果才会落地。
  await act(() => new Promise((resolve) => setTimeout(resolve, PROBE_MIN_DISPLAY_MS)));
}

beforeEach(() => {
  installDesktopAPI(runtimeConfigFor(designServer.url));
  probeResults[designServer.url] = { kind: "ok", server: designServer };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ServerSettingsTab", () => {
  it("shows the current server and hides it from the LAN list", async () => {
    await openTab([designServer, devServer]);

    expect(screen.getByRole("heading", { name: "服务器" })).toBeInTheDocument();
    expect(
      screen.getByText("这台电脑连接的 Marvis 服务器。切换后需要重新登录。"),
    ).toBeInTheDocument();

    // 当前服务器：名称、地址（不带协议），探测通过后显示“已连接”。
    expect(screen.getAllByText("设计部 Marvis")).toHaveLength(1);
    expect(screen.getByText("192.168.1.20:13840")).toBeInTheDocument();
    expect(screen.getByText("已连接")).toBeInTheDocument();
    expect(mocks.probe).toHaveBeenCalledWith(designServer.url);

    // 局域网列表只剩另一台。
    const rows = lanRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("marvis-dev");
    expect(rows[0]).toHaveTextContent("192.168.1.37:13840 · v0.6.5");
  });

  it("shows an offline status when the current server cannot be reached", async () => {
    probeResults = {};

    await openTab([devServer]);

    expect(screen.getByText("无法连接")).toBeInTheDocument();
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
    // 连不上时仍显示已保存的名称和地址。
    expect(screen.getByText("设计部 Marvis")).toBeInTheDocument();
    expect(screen.getByText("192.168.1.20:13840")).toBeInTheDocument();
  });

  it("treats a failing probe channel as offline", async () => {
    mocks.probe.mockRejectedValue(new Error("ipc closed"));

    await openTab([]);

    expect(screen.getByText("无法连接")).toBeInTheDocument();
  });

  it("does not show a status until the first probe settles", async () => {
    let resolveProbe: (result: ProbeResult) => void = () => {};
    mocks.probe.mockReturnValueOnce(new Promise<ProbeResult>((resolve) => (resolveProbe = resolve)));

    await openTab([]);
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
    expect(screen.queryByText("无法连接")).not.toBeInTheDocument();

    await act(async () => resolveProbe({ kind: "ok", server: designServer }));
    expect(screen.getByText("已连接")).toBeInTheDocument();
  });

  it("falls back to the runtime config when no server was saved, and hides it by instanceId", async () => {
    // 手写的 desktop.json 预设：server.json 里没有选择，地址用的是本机别名。
    mocks.current.mockResolvedValue(null);
    installRuntimeConfig(runtimeConfigFor("http://localhost:13840"));
    probeResults["http://localhost:13840"] = { kind: "ok", server: devServer };

    await openTab([designServer, devServer]);

    // 探测通过后名称换成服务器自己的名称，本机的同一实例即使地址不同也被藏起来。
    expect(screen.getByText("marvis-dev")).toBeInTheDocument();
    expect(screen.getByText("localhost:13840")).toBeInTheDocument();
    expect(screen.getByText("已连接")).toBeInTheDocument();

    const rows = lanRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("设计部 Marvis");
  });

  it("uses the host as the name and hides by URL when the preset cannot be probed", async () => {
    mocks.current.mockResolvedValue(null);
    installRuntimeConfig(runtimeConfigFor(devServer.url));

    await openTab([designServer, devServer]);

    // 探测不通时没有真实名称，主机名同时作为名称和地址。
    expect(screen.getAllByText("192.168.1.37:13840")).toHaveLength(2);
    expect(screen.getByText("无法连接")).toBeInTheDocument();

    const rows = lanRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("设计部 Marvis");
  });

  it("asks before switching, then logs out and selects", async () => {
    await openTab([designServer, devServer]);

    fireEvent.click(within(lanRows()[0]!).getByRole("button", { name: "切换" }));

    const dialog = await screen.findByRole("alertdialog", { name: "切换到 marvis-dev？" });
    // 对话框给出带协议的完整地址；HTTP 连接时与连接页一样提示不加密。
    expect(dialog).toHaveTextContent("会退出当前账号，连接到 http://192.168.1.37:13840 后重新登录。");
    expect(dialog).toHaveTextContent(HTTP_WARNING);
    // 确认之前什么都不会发生。
    expect(mocks.calls).toEqual([]);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "切换" }));
    });

    // 先把守护进程和网页会话都退出，再保存选择。
    await waitFor(() => expect(mocks.select).toHaveBeenCalledOnce());
    expect(mocks.calls).toEqual(["teardown", "clear", "logout", "select"]);
    expect(mocks.select).toHaveBeenCalledWith({
      url: devServer.url,
      name: devServer.name,
      instanceId: devServer.instanceId,
      source: SERVER_SOURCE_LAN,
      appUrl: devServer.appUrl,
    });
  });

  it("waits for the logout teardown before selecting", async () => {
    let finishTeardown: () => void = () => {};
    mocks.daemonLogout.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          mocks.calls.push("teardown");
          finishTeardown = resolve;
        }),
    );

    await openTab([devServer]);
    fireEvent.click(within(lanRows()[0]!).getByRole("button", { name: "切换" }));
    const dialog = await screen.findByRole("alertdialog");

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "切换" }));
    });

    expect(mocks.select).not.toHaveBeenCalled();
    // 退出过程中对话框的两个按钮都不可再点。
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "切换" })).toBeDisabled();

    await act(async () => finishTeardown());

    await waitFor(() => expect(mocks.select).toHaveBeenCalledOnce());
  });

  it("closes the confirmation without side effects on cancel", async () => {
    await openTab([devServer]);

    fireEvent.click(within(lanRows()[0]!).getByRole("button", { name: "切换" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mocks.calls).toEqual([]);
    expect(mocks.daemonLogout).not.toHaveBeenCalled();
  });

  it("reports a failed select with a toast instead of an unhandled rejection", async () => {
    mocks.select.mockRejectedValueOnce(new Error("write failed"));

    await openTab([devServer]);
    fireEvent.click(within(lanRows()[0]!).getByRole("button", { name: "切换" }));
    const dialog = await screen.findByRole("alertdialog");

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "切换" }));
    });

    // 此时已经退出登录；提示走全局 toast，不依赖这个标签页是否还挂载。
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("切换服务器失败"));
    expect(mocks.calls).toEqual(["teardown", "clear", "logout"]);
    // 标签页仍挂载时（本用例的桩不会卸载它），按钮恢复可用。
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "切换" })).toBeEnabled();
  });

  it("reports a failed logout with a toast and does not select", async () => {
    mocks.daemonLogout.mockRejectedValueOnce(new Error("ipc closed"));

    await openTab([devServer]);
    fireEvent.click(within(lanRows()[0]!).getByRole("button", { name: "切换" }));
    const dialog = await screen.findByRole("alertdialog");

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "切换" }));
    });

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("切换服务器失败"));
    expect(mocks.select).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "切换" })).toBeEnabled();
  });

  it("disables incompatible servers and says why", async () => {
    await openTab([oldServer]);

    const row = lanRows()[0]!;
    expect(row).toHaveTextContent("测试环境");
    expect(row).toHaveTextContent("服务器版本过旧");
    expect(within(row).getByRole("button", { name: "切换" })).toBeDisabled();
  });

  it("enables the manual switch only after a successful test", async () => {
    await openTab([devServer]);

    const input = screen.getByRole("textbox", { name: "服务器地址" }) as HTMLInputElement;
    expect(input.value).toBe(DEFAULT_SERVER_ADDRESS);
    expect(manualSwitchButton()).toBeDisabled();

    // 测试失败：仍不能切换，输入框标红。
    await runProbe({ kind: "unreachable" });
    expect(screen.getByText("无法连接到这个地址")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(manualSwitchButton()).toBeDisabled();

    // 测试通过：可以切换。
    await runProbe({ kind: "ok", server: testedServer() });
    expect(screen.getByText("可以连接 · 测试环境 · v0.6.5")).toBeInTheDocument();
    expect(manualSwitchButton()).toBeEnabled();

    // 地址被改动后结果作废，需要重新测试。
    fireEvent.change(input, { target: { value: "http://192.168.1.99:13840" } });
    expect(manualSwitchButton()).toBeDisabled();
  });

  it("switches to the tested address as a manual server", async () => {
    await openTab([]);

    const tested = testedServer();
    await runProbe({ kind: "ok", server: tested });
    fireEvent.click(manualSwitchButton());

    const dialog = await screen.findByRole("alertdialog", { name: "切换到 测试环境？" });
    expect(dialog).toHaveTextContent("会退出当前账号，连接到 http://192.168.1.58:13840 后重新登录。");

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "切换" }));
    });

    await waitFor(() => expect(mocks.select).toHaveBeenCalledOnce());
    expect(mocks.calls).toEqual(["teardown", "clear", "logout", "select"]);
    expect(mocks.select).toHaveBeenCalledWith({
      url: tested.url,
      name: tested.name,
      instanceId: tested.instanceId,
      source: SERVER_SOURCE_MANUAL,
      appUrl: tested.appUrl,
    });
  });

  it("shows the scanning status for the scan window, then a rescan button", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    renderTab();
    await act(async () => {});

    expect(screen.getByText("正在查找")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新查找" })).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(LAN_SCAN_WINDOW_MS);
    });

    expect(screen.queryByText("正在查找")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新查找" }));
    expect(mocks.rescan).toHaveBeenCalledOnce();
    // 重新查找后再次进入查找窗口。
    expect(screen.getByText("正在查找")).toBeInTheDocument();
  });

  it("shows the not-found note only when nothing at all was discovered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    renderTab();
    await act(async () => {});
    act(() => pushServers([]));
    act(() => {
      vi.advanceTimersByTime(LAN_SCAN_WINDOW_MS);
    });

    expect(
      screen.getByText("局域网中没有找到服务器。电脑和服务器需要连在同一个局域网。"),
    ).toBeInTheDocument();

    // 只发现了当前这一台：列表为空，但不能说“没有找到服务器”。
    act(() => pushServers([designServer]));
    expect(
      screen.queryByText("局域网中没有找到服务器。电脑和服务器需要连在同一个局域网。"),
    ).not.toBeInTheDocument();
    expect(lanRows()).toHaveLength(0);
  });

  it("unsubscribes from discovery when it unmounts", async () => {
    const { unmount } = renderTab();
    await act(async () => {});

    unmount();

    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });
});

// 手动测试通过的服务器：与局域网里的任何一台都不同。
function testedServer(): DiscoveredServer {
  return lanServer({
    url: "http://192.168.1.58:13840",
    name: "测试环境",
    version: "v0.6.5",
    instanceId: "inst-test-env",
    host: "test-env.local",
    appUrl: "",
  });
}

function installRuntimeConfig(runtimeConfig: unknown) {
  Object.defineProperty(window, "desktopAPI", {
    configurable: true,
    value: { ...window.desktopAPI, runtimeConfig },
  });
}

const HTTP_WARNING = "这个服务器使用 HTTP 连接，同一网络中的设备可能看到传输的内容。";

describe("ServerSettingsTab switch confirmation", () => {
  it("shows the https address without the HTTP warning", async () => {
    await openTab([]);

    await runProbe({ kind: "ok", server: { ...testedServer(), url: "https://marvis.example.com" } });
    fireEvent.click(manualSwitchButton());

    const dialog = await screen.findByRole("alertdialog", { name: "切换到 测试环境？" });
    expect(dialog).toHaveTextContent("会退出当前账号，连接到 https://marvis.example.com 后重新登录。");
    expect(dialog).not.toHaveTextContent(HTTP_WARNING);
  });

  it("shows the probe result without a dangling separator when the version is empty", async () => {
    await openTab([]);

    await runProbe({ kind: "ok", server: { ...testedServer(), version: "" } });

    const address = screen.getByRole("group", { name: "服务器地址" });
    expect(within(address).getByRole("status")).toHaveTextContent(/^可以连接 · 测试环境$/);
  });
});
