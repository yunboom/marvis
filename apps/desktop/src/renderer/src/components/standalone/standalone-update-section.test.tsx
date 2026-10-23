import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@marvis/core/i18n/react";
import { RESOURCES } from "@marvis/views/locales";
import {
  SERVER_SOURCE_LAN,
  SERVER_SOURCE_STANDALONE,
  type ServerSource,
} from "../../../../shared/server-discovery";
import type { StandaloneStatus, StandaloneUpdateStatus } from "../../../../shared/standalone";
import { UpdatesSettingsTab } from "../updates-settings-tab";
import { StandaloneUpdateSection } from "./standalone-update-section";

const MB = 1024 * 1024;
const MINUTE_MS = 60_000;

const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  openLogs: vi.fn(),
  autoDownloadUpdates: vi.fn(),
  setAutoDownloadUpdates: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: vi.fn() },
}));

let currentStatus: StandaloneStatus;
let pushStatus: (status: StandaloneStatus) => void = () => {};
let savedSource: ServerSource | null = SERVER_SOURCE_STANDALONE;

function status(update: Partial<StandaloneUpdateStatus> = {}): StandaloneStatus {
  return {
    phase: "running",
    version: "0.6.5",
    progress: null,
    error: null,
    lanUrl: null,
    localUrl: "http://127.0.0.1:13840",
    startedAt: null,
    update: {
      state: "latest",
      availableVersion: null,
      sizeBytes: null,
      progress: null,
      checkedAt: null,
      ...update,
    },
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.checkForUpdate.mockResolvedValue(undefined);
  mocks.installUpdate.mockResolvedValue(undefined);
  mocks.openLogs.mockResolvedValue(undefined);
  mocks.autoDownloadUpdates.mockResolvedValue(true);
  mocks.setAutoDownloadUpdates.mockResolvedValue(undefined);
  currentStatus = status();
  savedSource = SERVER_SOURCE_STANDALONE;

  Object.defineProperty(window, "desktopAPI", {
    configurable: true,
    value: {
      appInfo: { version: "0.6.5", os: "macos" },
      server: {
        current: async () =>
          savedSource === null
            ? null
            : { url: "http://127.0.0.1:13840", name: "studio", instanceId: "local", source: savedSource, appUrl: "" },
      },
      standalone: {
        onStatus: (callback: (next: StandaloneStatus) => void) => {
          pushStatus = callback;
          callback(currentStatus);
          return () => {};
        },
        checkForUpdate: mocks.checkForUpdate,
        installUpdate: mocks.installUpdate,
        openLogs: mocks.openLogs,
        autoDownloadUpdates: mocks.autoDownloadUpdates,
        setAutoDownloadUpdates: mocks.setAutoDownloadUpdates,
      },
    },
  });
  Object.defineProperty(window, "updater", {
    configurable: true,
    value: {
      getPreferences: async () => ({ automaticUpdates: true }),
      setAutomaticUpdates: vi.fn(),
      checkForUpdates: vi.fn(),
    },
  });
});

function withI18n(children: React.ReactNode) {
  return (
    <I18nProvider locale="zh-Hans" resources={RESOURCES}>
      {children}
    </I18nProvider>
  );
}

async function renderSection() {
  render(withI18n(<StandaloneUpdateSection />));
  await waitFor(() => expect(screen.getByRole("switch", { name: "自动下载资源更新" })).toBeEnabled());

  return screen.getByRole("region", { name: "单机模式资源" });
}

describe("StandaloneUpdateSection states", () => {
  it("latest: shows the version, last check and checks for updates", async () => {
    currentStatus = status({ checkedAt: new Date(Date.now() - 10 * MINUTE_MS).toISOString() });
    const section = await renderSection();

    expect(section).toHaveTextContent("已是最新版本");
    expect(section).toHaveTextContent("v0.6.5 · 上次检查 10 分钟前");

    fireEvent.click(within(section).getByRole("button", { name: "检查更新" }));
    await waitFor(() => expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1));
  });

  it("available: shows the size and installs", async () => {
    currentStatus = status({ state: "available", availableVersion: "0.6.6", sizeBytes: 18 * MB });
    const section = await renderSection();

    expect(section).toHaveTextContent("资源更新 v0.6.6");
    expect(section).toHaveTextContent("约 18 MB · 更新前自动备份数据，局域网连接中断约 10 秒");

    fireEvent.click(within(section).getByRole("button", { name: "更新" }));
    await waitFor(() => expect(mocks.installUpdate).toHaveBeenCalledTimes(1));
  });

  it("downloading: shows progress, speed and time left", async () => {
    currentStatus = status({
      state: "downloading",
      availableVersion: "0.6.6",
      progress: { percent: 51, receivedBytes: 9.2 * MB, totalBytes: 18 * MB, bytesPerSecond: 3.1 * MB, etaSeconds: 3 },
    });
    const section = await renderSection();

    expect(section).toHaveTextContent("正在下载资源更新");
    expect(within(section).getByRole("progressbar", { name: "下载资源更新" })).toHaveAttribute("aria-valuenow", "51");
    expect(section).toHaveTextContent("9.2 / 18.0 MB · 3.1 MB/s · 剩余约 3 秒");
    expect(within(section).queryByRole("button", { name: "更新" })).not.toBeInTheDocument();
  });

  it("installing: highlights the install step without actions", async () => {
    currentStatus = status({ state: "installing", availableVersion: "0.6.6" });
    const section = await renderSection();

    expect(section).toHaveTextContent("正在安装资源更新");
    expect(section).toHaveTextContent("局域网连接会短暂中断，完成后自动恢复");
    const steps = within(section).getByRole("list", { name: "更新步骤" });
    expect(within(steps).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "备份数据",
      "安装资源",
      "更新数据",
      "完成",
    ]);
    expect(within(steps).getByText("安装资源").closest("li")).toHaveAttribute("aria-current", "step");
    expect(within(section).queryByRole("button", { name: "检查更新" })).not.toBeInTheDocument();
  });

  it("rolled back: reports the restored version, opens logs and retries", async () => {
    currentStatus = status({ state: "rolled_back", availableVersion: "0.6.6" });
    const section = await renderSection();

    expect(within(section).getByText("更新失败，已恢复到 v0.6.5")).toHaveClass("text-destructive");
    expect(section).toHaveTextContent("数据已恢复到更新前的状态");

    fireEvent.click(within(section).getByRole("button", { name: "查看日志" }));
    expect(mocks.openLogs).toHaveBeenCalledTimes(1);

    fireEvent.click(within(section).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(mocks.installUpdate).toHaveBeenCalledTimes(1));
  });

  it("follows pushed status changes", async () => {
    const section = await renderSection();

    act(() => pushStatus(status({ state: "available", availableVersion: "0.6.6", sizeBytes: null })));

    expect(section).toHaveTextContent("资源更新 v0.6.6");
    expect(section).toHaveTextContent("更新前自动备份数据，局域网连接中断约 10 秒");
  });
});

describe("StandaloneUpdateSection auto download", () => {
  it("reflects and saves the preference", async () => {
    mocks.autoDownloadUpdates.mockResolvedValue(false);
    render(withI18n(<StandaloneUpdateSection />));

    const toggle = screen.getByRole("switch", { name: "自动下载资源更新" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));

    fireEvent.click(toggle);

    await waitFor(() => expect(mocks.setAutoDownloadUpdates).toHaveBeenCalledWith(true));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  });
});

describe("UpdatesSettingsTab with standalone mode", () => {
  it("adds the resources section only when standalone mode is selected", async () => {
    render(withI18n(<UpdatesSettingsTab />));

    expect(await screen.findByRole("region", { name: "单机模式资源" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Marvis" })).toBeInTheDocument();
  });

  it("keeps only the app updates for a remote server", async () => {
    savedSource = SERVER_SOURCE_LAN;
    render(withI18n(<UpdatesSettingsTab />));

    expect(await screen.findByText("当前版本")).toBeInTheDocument();
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "单机模式资源" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Marvis" })).not.toBeInTheDocument();
  });
});
