import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@marvis/core/i18n/react";
import { RESOURCES } from "@marvis/views/locales";
import type { SelectedServer } from "../../../../shared/server-discovery";
import type { StandaloneStatus } from "../../../../shared/standalone";
import { StandaloneGate } from "./standalone-gate";

const mocks = vi.hoisted(() => ({
  current: vi.fn(),
  retry: vi.fn(),
  openLogs: vi.fn(),
  stop: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("../server/use-logout-before-switch", () => ({
  useLogoutBeforeSwitch: () => mocks.logout,
}));

// 连接页自己的流程有单独的测试，这里只验证切换与返回的接线。
vi.mock("../server/connect-server-screen", () => ({
  ConnectServerScreen: ({ beforeSwitch, onBack }: { beforeSwitch: () => Promise<void>; onBack: () => void }) => (
    <div>
      <p>connect-screen</p>
      <button type="button" onClick={() => void beforeSwitch()}>
        pick
      </button>
      <button type="button" onClick={onBack}>
        back
      </button>
    </div>
  ),
}));

let pushStatus: (status: StandaloneStatus) => void = () => {};

function status(overrides: Partial<StandaloneStatus> = {}): StandaloneStatus {
  return {
    phase: "starting",
    version: "0.6.6",
    progress: null,
    error: null,
    lanUrl: null,
    localUrl: null,
    startedAt: null,
    update: { state: "latest", availableVersion: null, sizeBytes: null, progress: null, checkedAt: null },
    ...overrides,
  };
}

function selected(source: SelectedServer["source"]): SelectedServer {
  return { url: "http://127.0.0.1:13840", name: "mac-mini", instanceId: "", source, appUrl: "" };
}

function renderGate() {
  return render(
    <I18nProvider locale="zh-Hans" resources={RESOURCES}>
      <StandaloneGate>
        <div data-testid="app">app</div>
      </StandaloneGate>
    </I18nProvider>,
  );
}

beforeEach(() => {
  mocks.current.mockReset();
  mocks.retry.mockReset().mockResolvedValue(undefined);
  mocks.openLogs.mockReset().mockResolvedValue(undefined);
  mocks.stop.mockReset().mockResolvedValue(undefined);
  mocks.logout.mockReset().mockResolvedValue(undefined);

  Object.defineProperty(window, "desktopAPI", {
    configurable: true,
    value: {
      server: { current: mocks.current },
      standalone: {
        retry: mocks.retry,
        openLogs: mocks.openLogs,
        stop: mocks.stop,
        onStatus: (callback: (next: StandaloneStatus) => void) => {
          pushStatus = callback;
          return () => {};
        },
      },
    },
  });
});

describe("StandaloneGate", () => {
  it("renders the app directly for a remote server", async () => {
    mocks.current.mockResolvedValue(selected("lan"));
    renderGate();

    expect(await screen.findByTestId("app")).toBeInTheDocument();
  });

  it("shows the status screen while standalone mode starts, then the app once running", async () => {
    mocks.current.mockResolvedValue(selected("standalone"));
    renderGate();
    await act(async () => {});

    act(() => pushStatus(status()));
    expect(screen.getByText("正在启动")).toBeInTheDocument();
    expect(screen.queryByTestId("app")).not.toBeInTheDocument();

    act(() => pushStatus(status({ phase: "running", localUrl: "http://127.0.0.1:13840" })));
    expect(screen.getByTestId("app")).toBeInTheDocument();

    // 运行过一次后，之后的重启不再卸载应用。
    act(() => pushStatus(status({ phase: "starting" })));
    expect(screen.getByTestId("app")).toBeInTheDocument();
  });

  it("offers retry and logs when standalone mode failed to start", async () => {
    mocks.current.mockResolvedValue(selected("standalone"));
    renderGate();
    await act(async () => {});

    act(() => pushStatus(status({ phase: "failed", error: { code: "start_failed" } })));

    expect(screen.getByRole("heading", { name: "单机模式暂时无法使用" })).toBeInTheDocument();
    expect(screen.getByText("资源已就绪，但未能开始运行。")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
    });
    expect(mocks.retry).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "查看日志" }));
    expect(mocks.openLogs).toHaveBeenCalledOnce();
  });

  it("switches to another server from a failed start and can go back", async () => {
    mocks.current.mockResolvedValue(selected("standalone"));
    renderGate();
    await act(async () => {});
    act(() => pushStatus(status({ phase: "failed", error: { code: "start_failed" } })));

    fireEvent.click(screen.getByRole("button", { name: "切换服务器" }));
    expect(screen.getByText("connect-screen")).toBeInTheDocument();

    // 换服务器前先退出旧账号，再停掉本机服务。
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "pick" }));
    });
    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.logout.mock.invocationCallOrder[0]).toBeLessThan(mocks.stop.mock.invocationCallOrder[0]);

    fireEvent.click(screen.getByRole("button", { name: "back" }));
    expect(screen.getByRole("heading", { name: "单机模式暂时无法使用" })).toBeInTheDocument();
  });
});
