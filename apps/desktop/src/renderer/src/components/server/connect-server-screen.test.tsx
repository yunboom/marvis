import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@marvis/core/i18n/react";
import { RESOURCES } from "@marvis/views/locales";
import {
  DEFAULT_SERVER_ADDRESS,
  SERVER_SOURCE_LAN,
  SERVER_SOURCE_MANUAL,
  type DiscoveredServer,
  type ProbeResult,
} from "../../../../shared/server-discovery";
import { ConnectServerScreen } from "./connect-server-screen";
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
}));

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

  Object.defineProperty(window, "desktopAPI", {
    configurable: true,
    value: {
      server: {
        discover: mocks.discover,
        rescan: mocks.rescan,
        probe: mocks.probe,
        select: mocks.select,
      },
    },
  });
}

function renderScreen(props: { suggestedAddress?: string } = {}) {
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

async function runProbe(result: ProbeResult) {
  mocks.probe.mockResolvedValueOnce(result);
  fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
  // 让 probe 的 Promise 落地。
  await act(async () => {});
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  installDesktopAPI();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ConnectServerScreen", () => {
  it("lists discovered servers, disables incompatible ones, and continues to the confirm step", () => {
    renderScreen();
    settleDiscovery([designServer, devServer, oldServer]);

    // radio 只有三个服务器行，地址栏不是 radio。
    expect(screen.getAllByRole("radio")).toHaveLength(3);

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

    // 默认选中第一行。
    expect(design).toHaveAttribute("aria-checked", "true");
    expect(dev).toHaveAttribute("aria-checked", "false");

    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    expect(screen.getByRole("heading", { name: "连接到 设计部 Marvis？" })).toBeInTheDocument();
    expect(screen.getByText("http://192.168.1.20:13840")).toBeInTheDocument();
    expect(screen.getByText("v0.6.5")).toBeInTheDocument();
    expect(screen.getByText("design-mac-mini.local")).toBeInTheDocument();
  });

  it("keeps continue disabled while scanning unless the user picked a row", () => {
    renderScreen();
    act(() => pushServers([designServer, devServer]));

    // 查找窗口内默认选中的行还可能变化，先不让继续。
    expect(screen.getByText("正在查找")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续" })).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: /marvis-dev/ }));
    expect(screen.getByRole("button", { name: "继续" })).toBeEnabled();
  });

  it("pre-fills the address field and only enables continue after a successful test", async () => {
    renderScreen();
    settleDiscovery([designServer]);

    expect(addressInput().value).toBe(DEFAULT_SERVER_ADDRESS);

    // 选中地址栏：没测试通过之前不能继续。
    fireEvent.focus(addressInput());
    expect(addressGroup()).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("radio", { name: /设计部 Marvis/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "继续" })).toBeDisabled();

    await runProbe({ kind: "ok", server: designServer });

    expect(mocks.probe).toHaveBeenCalledWith(DEFAULT_SERVER_ADDRESS);
    expect(screen.getByText("可以连接 · 设计部 Marvis · v0.6.5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续" })).toBeEnabled();

    // 继续到确认步骤，之后连接以 manual 来源保存。
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
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
    expect(screen.getByRole("button", { name: "继续" })).toBeDisabled();
  });

  it("drops the test result when the address is edited", async () => {
    renderScreen();
    settleDiscovery([]);

    await runProbe({ kind: "ok", server: designServer });
    expect(screen.getByRole("button", { name: "继续" })).toBeEnabled();

    fireEvent.change(addressInput(), { target: { value: "http://192.168.1.99:13840" } });

    expect(screen.queryByText("可以连接 · 设计部 Marvis · v0.6.5")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续" })).toBeDisabled();
  });

  it("exposes the address controls outside any radio and conveys selection with aria-current", async () => {
    renderScreen();
    settleDiscovery([designServer]);

    // 默认选中第一个服务器行：地址栏的 group 不带 aria-current。
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
    expect(within(screen.getByRole("radiogroup")).queryByRole("textbox")).toBeNull();

    // 名称只来自可见标签，不再重复写 aria-label。
    expect(group).not.toHaveAttribute("aria-label");
    expect(input).not.toHaveAttribute("aria-label");
    expect(group).toHaveAttribute("aria-current", "true");

    // 选回服务器行后，地址栏不再是当前项。
    fireEvent.click(screen.getByRole("radio", { name: /设计部 Marvis/ }));
    expect(addressGroup()).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("radio", { name: /设计部 Marvis/ })).toHaveAttribute("aria-checked", "true");
  });

  it("shows the not-found note and selects the address field when nothing is discovered", () => {
    renderScreen();
    settleDiscovery([]);

    expect(
      screen.getByText("局域网中没有找到服务器。电脑和服务器需要连在同一个局域网。"),
    ).toBeInTheDocument();
    expect(screen.getByText("输入服务器地址")).toBeInTheDocument();
    expect(screen.queryByText("局域网中的服务器")).not.toBeInTheDocument();
    expect(addressGroup()).toHaveAttribute("aria-current", "true");

    // 重新查找按钮会重新扫描。
    fireEvent.click(screen.getByRole("button", { name: "重新查找" }));
    expect(mocks.rescan).toHaveBeenCalledOnce();
  });

  it("shows the HTTP warning on the confirm step and calls select on connect", async () => {
    renderScreen();
    settleDiscovery([designServer, devServer]);

    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    expect(
      screen.getByText("这个服务器使用 HTTP 连接，同一网络中的设备可能看到传输的内容。"),
    ).toBeInTheDocument();

    // 返回再继续仍停在同一选择上。
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.getByRole("radio", { name: /设计部 Marvis/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

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

  it("does not warn about HTTPS servers", () => {
    renderScreen();
    settleDiscovery([lanServer({ url: "https://marvis.example.com" })]);

    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("pre-fills the suggested address instead of the default", () => {
    renderScreen({ suggestedAddress: "http://localhost:18920" });
    settleDiscovery([]);

    expect(addressInput().value).toBe("http://localhost:18920");
  });

  it("summarises the current choice beside the actions", async () => {
    renderScreen();
    settleDiscovery([designServer]);

    // 选中的服务器：摘要和行里各出现一次地址 · 版本。
    expect(screen.getAllByText("192.168.1.20:13840 · v0.6.5")).toHaveLength(2);

    // 选中地址栏、还没测试：摘要提示先测试。
    fireEvent.focus(addressInput());
    expect(screen.getByText("测试连接通过后可以继续")).toBeInTheDocument();

    await runProbe({ kind: "ok", server: lanServer({ url: "http://192.168.1.99:13840" }) });
    expect(screen.getByText("192.168.1.99:13840 · v0.6.5")).toBeInTheDocument();
  });

  it("unsubscribes from discovery when it unmounts", () => {
    const { unmount } = renderScreen();

    unmount();

    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });
});
