import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@marvis/core/i18n/react";
import { RESOURCES } from "@marvis/views/locales";
import type { StandaloneProgress, StandaloneStatus } from "../../../../shared/standalone";
import {
  PREPARE_MODE_GATE,
  PREPARE_MODE_SETUP,
  StandalonePrepareScreen,
  type StandalonePrepareScreenProps,
} from "./standalone-prepare-screen";
import { useStandaloneStatus } from "./use-standalone-status";

const MB = 1024 * 1024;

const mocks = vi.hoisted(() => ({
  pause: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  enter: vi.fn(),
  openLogs: vi.fn(),
}));

let pushStatus: (status: StandaloneStatus) => void = () => {};

function status(overrides: Partial<StandaloneStatus> = {}): StandaloneStatus {
  return {
    phase: "downloading",
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

function progress(overrides: Partial<StandaloneProgress> = {}): StandaloneProgress {
  return {
    percent: 54,
    receivedBytes: 25.6 * MB,
    totalBytes: 40.6 * MB,
    bytesPerSecond: 4.2 * MB,
    etaSeconds: 4,
    ...overrides,
  };
}

// 和连接页一样：状态来自 onStatus 订阅。
function Subscribed(props: Omit<StandalonePrepareScreenProps, "status">) {
  const current = useStandaloneStatus();

  return <StandalonePrepareScreen status={current} {...props} />;
}

function renderScreen(props: Partial<Omit<StandalonePrepareScreenProps, "status">> = {}) {
  return render(
    <I18nProvider locale="zh-Hans" resources={RESOURCES}>
      <Subscribed mode={PREPARE_MODE_SETUP} {...props} />
    </I18nProvider>,
  );
}

function push(next: StandaloneStatus) {
  act(() => pushStatus(next));
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.cancel.mockResolvedValue(undefined);
  mocks.retry.mockResolvedValue(undefined);
  mocks.enter.mockResolvedValue(undefined);
  mocks.openLogs.mockResolvedValue(undefined);

  Object.defineProperty(window, "desktopAPI", {
    configurable: true,
    value: {
      standalone: {
        ...mocks,
        onStatus: (callback: (next: StandaloneStatus) => void) => {
          pushStatus = callback;
          return () => {};
        },
      },
    },
  });
});

describe("StandalonePrepareScreen", () => {
  it("shows download progress and pauses", () => {
    renderScreen();
    push(status({ progress: progress() }));

    expect(screen.getByRole("heading", { name: "正在准备单机模式" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "资源准备进度" })).toHaveAttribute("aria-valuenow", "54");
    expect(screen.getByText("正在下载资源")).toBeInTheDocument();
    expect(screen.getByText("25.6 / 40.6 MB")).toBeInTheDocument();
    expect(screen.getByText("4.2 MB/s · 剩余约 4 秒")).toBeInTheDocument();
    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("下载");

    fireEvent.click(screen.getByRole("button", { name: "暂停下载" }));
    expect(mocks.pause).toHaveBeenCalledOnce();
  });

  it("formats longer remaining time in minutes", () => {
    renderScreen();
    push(status({ progress: progress({ etaSeconds: 130 }) }));

    expect(screen.getByText("4.2 MB/s · 剩余约 3 分钟")).toBeInTheDocument();
  });

  it("resumes a paused download", () => {
    renderScreen();
    push(status({ phase: "paused", progress: progress() }));

    expect(screen.getByRole("heading", { name: "下载已暂停" })).toBeInTheDocument();
    expect(screen.getByText("网络恢复后自动继续")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "继续下载" }));
    expect(mocks.resume).toHaveBeenCalledOnce();
  });

  it("cancels and returns to the connect screen", async () => {
    const onCancelled = vi.fn();
    renderScreen({ onCancelled });
    push(status({ progress: progress() }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
    });

    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(onCancelled).toHaveBeenCalledOnce();
  });

  it("shows an indeterminate bar while installing", () => {
    renderScreen();
    push(status({ phase: "installing", progress: progress({ percent: 95 }) }));

    expect(screen.getByText("正在安装资源")).toBeInTheDocument();
    expect(screen.getByText("首次安装约需 1 分钟")).toBeInTheDocument();
    expect(screen.getByTestId("standalone-progress-sheen")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂停下载" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument();
  });

  it("offers retry and change settings when the port is in use", async () => {
    const onEditSettings = vi.fn();
    renderScreen({ onEditSettings });
    push(status({ phase: "failed", error: { code: "port_in_use", port: 13840 }, progress: progress({ percent: 95 }) }));

    expect(screen.getByRole("heading", { name: "资源安装失败" })).toBeInTheDocument();
    expect(
      screen.getByText("网络端口 13840 被其他程序占用。修改端口后重试，已下载的资源会保留。"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看日志" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "修改设置" }));
    expect(onEditSettings).toHaveBeenCalledOnce();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
    });
    expect(mocks.retry).toHaveBeenCalledOnce();
  });

  it("offers retry and logs after a network failure", () => {
    renderScreen({ onEditSettings: vi.fn() });
    push(status({ phase: "failed", error: { code: "network" }, progress: progress() }));

    expect(screen.getByText("网络连接中断。网络恢复后重试，已下载的资源会保留。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "修改设置" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看日志" }));
    expect(mocks.openLogs).toHaveBeenCalledOnce();
  });

  it("goes back to the connect screen after a failed install", async () => {
    const onCancelled = vi.fn();
    renderScreen({ onCancelled });
    push(status({ phase: "failed", error: { code: "manifest" } }));

    expect(screen.queryByRole("button", { name: "切换服务器" })).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "返回" }));
    });

    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(onCancelled).toHaveBeenCalledOnce();
  });

  it("offers switching servers when the local server fails at launch", () => {
    const onSwitchServer = vi.fn();
    renderScreen({ mode: PREPARE_MODE_GATE, onSwitchServer });
    push(status({ phase: "failed", version: "0.6.6", error: { code: "start_failed" } }));

    expect(screen.queryByRole("button", { name: "返回" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "切换服务器" }));

    expect(onSwitchServer).toHaveBeenCalledOnce();
  });

  it.each([
    [false, "当前只在这台电脑上使用，可在 设置 › 服务器 中允许局域网连接。"],
    [true, "局域网中的设备可以自动发现这台电脑，退出 Marvis 后连接断开。"],
  ])("shows the ready state (LAN %s) and enters Marvis", async (lan, subtitle) => {
    renderScreen();
    push(
      status({
        phase: "running",
        version: "0.6.6",
        localUrl: "http://127.0.0.1:13840",
        lanUrl: lan ? "http://192.168.1.20:13840" : null,
      }),
    );

    expect(screen.getByRole("heading", { name: "单机模式已就绪" })).toBeInTheDocument();
    expect(screen.getByText("资源已就绪")).toBeInTheDocument();
    expect(screen.getByText("版本 v0.6.6")).toBeInTheDocument();
    expect(screen.getByText(subtitle)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "进入 Marvis" }));
    });
    expect(mocks.enter).toHaveBeenCalledOnce();
  });
});
