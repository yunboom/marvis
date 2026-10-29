import type { ComponentProps } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@marvis/core/i18n/react";
import { RESOURCES } from "@marvis/views/locales";
import {
  MARVIS_CLOUD_SERVER_URL,
  SERVER_SOURCE_LAN,
  SERVER_SOURCE_MANUAL,
  type DiscoveredServer,
  type ProbeResult,
} from "../../../../shared/server-discovery";
import type { StandaloneStatus } from "../../../../shared/standalone";
import { ConnectServerScreen } from "./connect-server-screen";
import { PROBE_MIN_DISPLAY_MS } from "./server-address-field";
import { LAN_SCAN_WINDOW_MS } from "./use-lan-servers";

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

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  rescan: vi.fn(),
  probe: vi.fn(),
  select: vi.fn(),
  unsubscribe: vi.fn(),
  standaloneOnStatus: vi.fn(),
  standaloneEnter: vi.fn(),
  standaloneDefaults: vi.fn(),
}));

// 单机模式的状态：默认未安装。
function standaloneStatus(overrides: Partial<StandaloneStatus> = {}): StandaloneStatus {
  return {
    phase: "not_installed",
    version: null,
    progress: null,
    error: null,
    lanUrl: null,
    localUrl: null,
    startedAt: null,
    update: { state: "latest", availableVersion: null, sizeBytes: null, progress: null, checkedAt: null },
    ...overrides,
  };
}

// 主进程订阅时立即推送的单机模式状态。
let initialStandaloneStatus: StandaloneStatus = standaloneStatus();

// 触发主进程推送的发现列表。
let pushServers: (list: DiscoveredServer[]) => void = () => {};

function installDesktopAPI() {
  mocks.discover.mockReset().mockImplementation((onChange: (list: DiscoveredServer[]) => void) => {
    pushServers = onChange;
    return mocks.unsubscribe;
  });
  mocks.rescan.mockReset();
  mocks.probe.mockReset();
  mocks.select.mockReset().mockResolvedValue(undefined);
  mocks.unsubscribe.mockReset();
  mocks.standaloneOnStatus.mockReset().mockImplementation((callback: (status: StandaloneStatus) => void) => {
    callback(initialStandaloneStatus);
    return () => {};
  });
  mocks.standaloneEnter.mockReset().mockResolvedValue(undefined);
  mocks.standaloneDefaults.mockReset().mockReturnValue(new Promise(() => {}));

  Object.defineProperty(window, "desktopAPI", {
    configurable: true,
    value: {
      appInfo: { os: "macos", version: "0.6.5" },
      server: {
        discover: mocks.discover,
        rescan: mocks.rescan,
        probe: mocks.probe,
        select: mocks.select,
      },
      standalone: {
        onStatus: mocks.standaloneOnStatus,
        enter: mocks.standaloneEnter,
        defaults: mocks.standaloneDefaults,
      },
    },
  });
}

function renderScreen(props: ComponentProps<typeof ConnectServerScreen> = {}) {
  return render(
    <I18nProvider locale="zh-Hans" resources={RESOURCES}>
      <ConnectServerScreen {...props} />
    </I18nProvider>,
  );
}

// 推送一份发现列表，并走完 5 秒的查找窗口。
function settleDiscovery(list: DiscoveredServer[]) {
  act(() => pushServers(list));
  act(() => {
    vi.advanceTimersByTime(LAN_SCAN_WINDOW_MS);
  });
}

// 地址栏的外层容器：group，名称取自可见的“服务器地址”标签。
function addressGroup(): HTMLElement {
  return screen.getByRole("group", { name: "服务器地址" });
}

function addressInput(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "服务器地址" }) as HTMLInputElement;
}

// 手动输入的示例地址：地址栏默认是空的，测试前先填上。
const MANUAL_ADDRESS = "http://192.168.1.20:13840";

async function runProbe(result: ProbeResult) {
  if (addressInput().value === "") {
    fireEvent.change(addressInput(), { target: { value: MANUAL_ADDRESS } });
  }
  mocks.probe.mockResolvedValueOnce(result);
  fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
  // 让 probe 的 Promise 落地，并走完“正在测试”的最短显示时长。
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PROBE_MIN_DISPLAY_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  initialStandaloneStatus = standaloneStatus();
  installDesktopAPI();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ConnectServerScreen", () => {
  it("lists discovered servers, disables incompatible ones, and connects to the picked one", async () => {
    renderScreen();
    settleDiscovery([designServer, devServer, oldServer]);

    // radio 是「Marvis 云服务」「在这台电脑上使用」和三个服务器行，地址栏不是 radio。
    expect(screen.getAllByRole("radio")).toHaveLength(5);

    const design = screen.getByRole("radio", { name: /设计部 Marvis/ });
    const dev = screen.getByRole("radio", { name: /marvis-dev/ });
    const old = screen.getByRole("radio", { name: /测试环境/ });
    expect(design).toBeEnabled();
    expect(dev).toBeEnabled();
    expect(old).toBeDisabled();

    // 第二行是本机，带“本机”标记；不兼容的一行说明原因。
    expect(dev).toHaveTextContent("本机");
    expect(old).toHaveTextContent("服务器版本过旧");
    expect(design).toHaveTextContent("192.168.1.20:13840 · v0.6.5");

    // 默认选中这台电脑，服务器行都不选中。
    expect(screen.getByRole("radio", { name: /在这台电脑上使用/ })).toHaveAttribute("aria-checked", "true");
    expect(design).toHaveAttribute("aria-checked", "false");

    fireEvent.click(design);
    expect(design).toHaveAttribute("aria-checked", "true");
    expect(dev).toHaveAttribute("aria-checked", "false");

    // 选中即可连接，没有额外的确认步骤；保存期间按钮显示进度并禁用。
    let resolveSelect: () => void = () => {};
    mocks.select.mockReturnValueOnce(new Promise<void>((resolve) => (resolveSelect = resolve)));
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    expect(mocks.select).toHaveBeenCalledWith({
      url: designServer.url,
      name: designServer.name,
      instanceId: designServer.instanceId,
      source: SERVER_SOURCE_LAN,
      appUrl: designServer.appUrl,
    });
    expect(screen.getByRole("button", { name: "正在连接..." })).toBeDisabled();

    await act(async () => resolveSelect());
  });

  it("lets the user pick a server while scanning is still running", () => {
    renderScreen();
    act(() => pushServers([designServer, devServer]));

    expect(screen.getByText("正在查找")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /在这台电脑上使用/ })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("radio", { name: /marvis-dev/ }));
    expect(screen.getByRole("button", { name: "连接" })).toBeEnabled();
  });

  it("starts the address field empty and only enables connect after a successful test", async () => {
    renderScreen();
    settleDiscovery([designServer]);

    expect(addressInput().value).toBe("");
    expect(addressInput()).toHaveAttribute("placeholder", MARVIS_CLOUD_SERVER_URL);

    // 选中地址栏：没测试通过之前不能连接。
    fireEvent.focus(addressInput());
    expect(addressGroup()).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("radio", { name: /设计部 Marvis/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "连接" })).toBeDisabled();

    await runProbe({ kind: "ok", server: designServer });

    expect(mocks.probe).toHaveBeenCalledWith(MANUAL_ADDRESS);
    expect(screen.getByText("可以连接 · 设计部 Marvis · v0.6.5")).toBeInTheDocument();
    // 连接以 manual 来源保存。
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "连接" }));
    });

    expect(mocks.select).toHaveBeenCalledWith({
      url: designServer.url,
      name: designServer.name,
      instanceId: designServer.instanceId,
      source: SERVER_SOURCE_MANUAL,
      appUrl: designServer.appUrl,
    });
  });

  it.each([
    ["unreachable", "无法连接到这个地址"],
    ["not_marvis", "这个地址不是 Marvis 服务器"],
    ["too_old", "服务器版本过旧"],
  ] as const)("shows the %s result and marks the input invalid", async (kind, text) => {
    renderScreen();
    settleDiscovery([designServer]);

    fireEvent.focus(addressInput());
    await runProbe({ kind });

    expect(screen.getByText(text, { selector: "[role=status] span" })).toBeInTheDocument();
    expect(addressInput()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "连接" })).toBeDisabled();
  });

  it("drops the test result when the address is edited", async () => {
    renderScreen();
    settleDiscovery([]);

    await runProbe({ kind: "ok", server: designServer });
    expect(screen.getByRole("button", { name: "连接" })).toBeEnabled();

    fireEvent.change(addressInput(), { target: { value: "http://192.168.1.99:13840" } });

    expect(screen.queryByText("可以连接 · 设计部 Marvis · v0.6.5")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "连接" })).toBeDisabled();
  });

  it("exposes the address controls outside any radio and conveys selection with aria-current", async () => {
    renderScreen();
    settleDiscovery([designServer]);

    // 默认选中这台电脑：地址栏的 group 不带 aria-current。
    expect(addressGroup()).not.toHaveAttribute("aria-current");

    fireEvent.focus(addressInput());
    await runProbe({ kind: "ok", server: designServer });

    // 输入框、“测试连接”和结果行都在名为“服务器地址”的 group 里。
    const group = addressGroup();
    const input = within(group).getByRole("textbox", { name: "服务器地址" });
    const testButton = within(group).getByRole("button", { name: "测试连接" });
    const status = within(group).getByRole("status");
    expect(status).toHaveTextContent("可以连接 · 设计部 Marvis · v0.6.5");

    // 它们都不是任何 radio 的后代（radio 的子树会被辅助技术剪掉）。
    for (const element of [group, input, testButton, status]) {
      expect(element.closest('[role="radio"]')).toBeNull();
    }
    for (const radiogroup of screen.getAllByRole("radiogroup")) {
      expect(within(radiogroup).queryByRole("textbox")).toBeNull();
    }

    // 名称只来自可见标签，不再重复写 aria-label。
    expect(group).not.toHaveAttribute("aria-label");
    expect(input).not.toHaveAttribute("aria-label");
    expect(group).toHaveAttribute("aria-current", "true");

    // 选回服务器行后，地址栏不再是当前项。
    fireEvent.click(screen.getByRole("radio", { name: /设计部 Marvis/ }));
    expect(addressGroup()).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("radio", { name: /设计部 Marvis/ })).toHaveAttribute("aria-checked", "true");
  });

  it("shows the not-found note and keeps this computer selected when nothing is discovered", () => {
    renderScreen();
    settleDiscovery([]);

    expect(
      screen.getByText("局域网中没有找到服务器。电脑和服务器需要连在同一个局域网。"),
    ).toBeInTheDocument();
    // 没有找到时小标题仍在，空状态放在它下面。
    expect(screen.getByText("局域网中的服务器")).toBeInTheDocument();
    expect(addressGroup()).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("radio", { name: /在这台电脑上使用/ })).toHaveAttribute("aria-checked", "true");

    // 重新查找按钮会重新扫描。
    fireEvent.click(screen.getByRole("button", { name: "重新查找" }));
    expect(mocks.rescan).toHaveBeenCalledOnce();
  });

  // 本机探测只要几毫秒：“正在测试”至少停留一小段时间，不会一闪而过。
  it("holds the testing line for a minimum time even when the probe answers at once", async () => {
    renderScreen();
    settleDiscovery([]);

    fireEvent.change(addressInput(), { target: { value: MANUAL_ADDRESS } });
    mocks.probe.mockResolvedValueOnce({ kind: "ok", server: designServer });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROBE_MIN_DISPLAY_MS - 1);
    });

    expect(within(addressGroup()).getByRole("status")).toHaveTextContent("正在测试");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(within(addressGroup()).getByRole("status")).toHaveTextContent(
      "可以连接 · 设计部 Marvis · v0.6.5",
    );
  });

  // 重新测试同一地址时，按钮文字和左栏摘要不跟着来回切换。
  it("keeps the button label and the summary steady while re-testing", async () => {
    renderScreen();
    settleDiscovery([]);
    await runProbe({ kind: "ok", server: designServer });

    let resolveProbe: (result: ProbeResult) => void = () => {};
    mocks.probe.mockReturnValueOnce(new Promise<ProbeResult>((resolve) => (resolveProbe = resolve)));
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(within(addressGroup()).getByRole("status")).toHaveTextContent("正在测试");
    expect(screen.getByRole("button", { name: "测试连接" })).toBeDisabled();
    expect(screen.getByText("192.168.1.20:13840 · v0.6.5")).toBeInTheDocument();

    await act(async () => {
      resolveProbe({ kind: "ok", server: designServer });
      await vi.advanceTimersByTimeAsync(PROBE_MIN_DISPLAY_MS);
    });

    expect(screen.getByRole("button", { name: "测试连接" })).toBeEnabled();
    expect(screen.getByText("可以连接 · 设计部 Marvis · v0.6.5")).toBeInTheDocument();
  });

  it("pre-fills the suggested address instead of the default", () => {
    renderScreen({ suggestedAddress: "http://localhost:18920" });
    settleDiscovery([]);

    expect(addressInput().value).toBe("http://localhost:18920");
  });

  it("summarises the current choice beside the actions", async () => {
    renderScreen();
    settleDiscovery([designServer]);

    // 默认是这台电脑：摘要提示下一步完成设置。
    expect(screen.getByText("下一步：完成设置")).toBeInTheDocument();

    // 选中的服务器：摘要和行里各出现一次地址 · 版本。
    fireEvent.click(screen.getByRole("radio", { name: /设计部 Marvis/ }));
    expect(screen.getAllByText("192.168.1.20:13840 · v0.6.5")).toHaveLength(2);

    // 选中地址栏、还没测试：摘要提示先测试。
    fireEvent.focus(addressInput());
    expect(screen.getByText("先测试连接")).toBeInTheDocument();

    await runProbe({ kind: "ok", server: lanServer({ url: "http://192.168.1.99:13840" }) });
    expect(screen.getByText("192.168.1.99:13840 · v0.6.5")).toBeInTheDocument();
  });

  it("unsubscribes from discovery when it unmounts", () => {
    const { unmount } = renderScreen();

    unmount();

    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("ConnectServerScreen standalone option", () => {
  it("offers first-time setup when standalone mode is not installed", () => {
    renderScreen();
    settleDiscovery([designServer]);

    const local = screen.getByRole("radio", { name: /在这台电脑上使用/ });
    expect(local).toHaveTextContent("单机模式");
    expect(local).toHaveTextContent("首次使用需下载约 40 MB 资源");
    expect(
      screen.getByText("连接 Marvis 云服务、在这台电脑上使用，或连接局域网中的服务器。之后可以在设置里更换。"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    expect(screen.getByRole("heading", { name: "完成单机模式设置" })).toBeInTheDocument();
    expect(mocks.standaloneDefaults).toHaveBeenCalledOnce();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("continues straight into standalone mode once it is installed", async () => {
    initialStandaloneStatus = standaloneStatus({ phase: "stopped", version: "0.6.6" });
    let resolveEnter: () => void = () => {};
    mocks.standaloneEnter.mockReturnValueOnce(new Promise<void>((resolve) => (resolveEnter = resolve)));
    renderScreen();
    settleDiscovery([]);

    expect(screen.getByRole("radio", { name: /在这台电脑上使用/ })).toHaveTextContent("已就绪 · v0.6.6");

    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    expect(mocks.standaloneEnter).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "正在进入..." })).toBeDisabled();

    await act(async () => resolveEnter());
  });

  it("switches back to the connect button when a server is picked", () => {
    renderScreen();
    settleDiscovery([designServer]);

    expect(screen.queryByRole("button", { name: "连接" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /设计部 Marvis/ }));

    expect(screen.getByRole("button", { name: "连接" })).toBeEnabled();
  });

  it("hides this computer's own standalone server from the LAN list", () => {
    initialStandaloneStatus = standaloneStatus({
      phase: "running",
      version: "0.6.6",
      lanUrl: designServer.url,
    });
    renderScreen();
    settleDiscovery([designServer, devServer]);

    expect(screen.queryByRole("radio", { name: /设计部 Marvis/ })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /marvis-dev/ })).toBeInTheDocument();
  });

  it("reopens the prepare screen when the last install was interrupted", () => {
    initialStandaloneStatus = standaloneStatus({
      phase: "paused",
      progress: {
        percent: 40,
        receivedBytes: 20 * 1024 * 1024,
        totalBytes: 40 * 1024 * 1024,
        bytesPerSecond: 0,
        etaSeconds: null,
      },
    });
    renderScreen();

    expect(screen.getByRole("heading", { name: "下载已暂停" })).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
});

describe("ConnectServerScreen opened from an existing session", () => {
  it("has no back button on first launch", () => {
    renderScreen();

    expect(screen.queryByRole("button", { name: "返回" })).not.toBeInTheDocument();
  });

  it("goes back to where it was opened from", () => {
    const onBack = vi.fn();
    renderScreen({ onBack });

    fireEvent.click(screen.getByRole("button", { name: "返回" }));

    expect(onBack).toHaveBeenCalledOnce();
  });

  it("runs beforeSwitch before saving the picked server", async () => {
    const order: string[] = [];
    const beforeSwitch = vi.fn(async () => {
      order.push("beforeSwitch");
    });
    mocks.select.mockImplementationOnce(async () => {
      order.push("select");
    });
    renderScreen({ beforeSwitch });
    settleDiscovery([designServer]);

    fireEvent.click(screen.getByRole("radio", { name: /设计部 Marvis/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "连接" }));
    });

    expect(order).toEqual(["beforeSwitch", "select"]);
  });

  it("runs beforeSwitch before entering standalone mode", async () => {
    initialStandaloneStatus = standaloneStatus({ phase: "stopped", version: "0.6.6" });
    const order: string[] = [];
    const beforeSwitch = vi.fn(async () => {
      order.push("beforeSwitch");
    });
    mocks.standaloneEnter.mockImplementationOnce(async () => {
      order.push("enter");
    });
    renderScreen({ beforeSwitch });
    settleDiscovery([]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "继续" }));
    });

    expect(order).toEqual(["beforeSwitch", "enter"]);
  });
});

const cloudServer = lanServer({
  url: MARVIS_CLOUD_SERVER_URL,
  name: "prod",
  version: "v0.0.2",
  instanceId: "inst-cloud",
  host: "omniai.shoplazza.site",
  appUrl: MARVIS_CLOUD_SERVER_URL,
});

function cloudRadio(): HTMLElement {
  return screen.getByRole("radio", { name: /Marvis 云服务/ });
}

// 走完云服务的探测和“正在测试”的最短显示时长。
async function settleCloudProbe() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PROBE_MIN_DISPLAY_MS);
  });
}

describe("ConnectServerScreen on first launch", () => {
  it("preselects the cloud server, tests it at once and connects after the user clicks", async () => {
    mocks.probe.mockResolvedValueOnce({ kind: "ok", server: cloudServer });
    renderScreen({ firstRun: true });
    settleDiscovery([]);

    expect(cloudRadio()).toHaveAttribute("aria-checked", "true");
    expect(cloudRadio()).toHaveTextContent("正在测试");
    expect(mocks.probe).toHaveBeenCalledExactlyOnceWith(MARVIS_CLOUD_SERVER_URL);
    expect(screen.getByRole("button", { name: "连接" })).toBeDisabled();

    await settleCloudProbe();

    expect(cloudRadio()).toHaveTextContent("omniai.shoplazza.site/marvis");
    expect(screen.getByText("omniai.shoplazza.site · v0.0.2")).toBeInTheDocument();
    // 测试通过也不自动连接。
    expect(mocks.select).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "连接" }));
    });

    expect(mocks.select).toHaveBeenCalledWith({
      url: MARVIS_CLOUD_SERVER_URL,
      name: "prod",
      instanceId: "inst-cloud",
      source: SERVER_SOURCE_MANUAL,
      appUrl: MARVIS_CLOUD_SERVER_URL,
    });
  });

  it("shows the failure on the cloud row and retries it", async () => {
    mocks.probe.mockResolvedValueOnce({ kind: "unreachable" });
    renderScreen({ firstRun: true });
    settleDiscovery([]);
    await settleCloudProbe();

    // 失败原因在云服务行下方，地址栏里没有结果行。
    expect(screen.getAllByText("无法连接到这个地址", { selector: "[role=status] span" })).toHaveLength(1);
    expect(within(addressGroup()).queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "连接" })).toBeDisabled();

    mocks.probe.mockResolvedValueOnce({ kind: "ok", server: cloudServer });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(cloudRadio()).toHaveTextContent("正在测试");
    await settleCloudProbe();

    expect(mocks.probe).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("无法连接到这个地址")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "连接" })).toBeEnabled();
  });

  it("leaves the manual address empty, untested and without an error", async () => {
    mocks.probe.mockResolvedValueOnce({ kind: "ok", server: cloudServer });
    renderScreen({ firstRun: true });
    settleDiscovery([]);
    await settleCloudProbe();

    expect(addressInput().value).toBe("");
    expect(addressInput()).toHaveAttribute("placeholder", MARVIS_CLOUD_SERVER_URL);
    expect(addressInput()).not.toHaveAttribute("aria-invalid");
    expect(addressGroup()).not.toHaveAttribute("aria-current");
    expect(within(addressGroup()).queryByRole("status")).toBeNull();
    // 只测了云服务。
    expect(mocks.probe).toHaveBeenCalledExactlyOnceWith(MARVIS_CLOUD_SERVER_URL);
  });

  it("keeps the dev suggested address in the field", async () => {
    mocks.probe.mockResolvedValueOnce({ kind: "ok", server: cloudServer });
    renderScreen({ firstRun: true, suggestedAddress: "http://localhost:18920" });
    await settleCloudProbe();

    expect(addressInput().value).toBe("http://localhost:18920");
    expect(cloudRadio()).toHaveAttribute("aria-checked", "true");
  });
});

describe("ConnectServerScreen switching from a saved server", () => {
  it("keeps this computer as the default and tests the cloud only once it is picked", async () => {
    renderScreen({ onBack: vi.fn() });
    settleDiscovery([designServer]);

    expect(screen.getByRole("radio", { name: /在这台电脑上使用/ })).toHaveAttribute("aria-checked", "true");
    expect(cloudRadio()).toHaveAttribute("aria-checked", "false");
    expect(mocks.probe).not.toHaveBeenCalled();

    mocks.probe.mockResolvedValueOnce({ kind: "ok", server: cloudServer });
    fireEvent.click(cloudRadio());
    await settleCloudProbe();

    expect(mocks.probe).toHaveBeenCalledExactlyOnceWith(MARVIS_CLOUD_SERVER_URL);
    expect(screen.getByRole("button", { name: "连接" })).toBeEnabled();
  });
});

describe("ConnectServerScreen sections", () => {
  it.each([
    ["servers are found", [designServer]],
    ["nothing is found", []],
  ] as const)("titles every section in order when %s", (_, list) => {
    renderScreen();
    settleDiscovery([...list]);

    const headings = ["云服务", "这台电脑", "局域网中的服务器", "其他地址"].map((label) =>
      screen.getByText(label, { selector: "span" }),
    );
    for (let i = 1; i < headings.length; i++) {
      expect(headings[i - 1]!.compareDocumentPosition(headings[i]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
  });

  // 回归：选中的地址栏已有墨色描边，测试失败时输入框不再叠一圈红色描边，错误由红色结果行表达。
  it("shows one indicator on a failed manual address: the selection outline plus red result text", async () => {
    renderScreen();
    settleDiscovery([]);

    fireEvent.focus(addressInput());
    await runProbe({ kind: "unreachable" });

    expect(addressGroup()).toHaveAttribute("aria-current", "true");
    expect(addressGroup().className).toContain("shadow-[0_0_0_1.5px_var(--color-foreground)]");
    expect(addressInput()).toHaveAttribute("aria-invalid", "true");
    expect(addressInput().className).not.toMatch(/destructive/);
    expect(within(addressGroup()).getByRole("status").className).toContain("text-destructive");
  });
});
