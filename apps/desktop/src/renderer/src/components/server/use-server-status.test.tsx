import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@marvis/core/i18n/react";
import { RESOURCES } from "@marvis/views/locales";
import {
  SERVER_SOURCE_LAN,
  SERVER_STATE_MOVED,
  SERVER_STATE_ONLINE,
  SERVER_STATE_RECONNECTING,
  SERVER_STATE_REPLACED,
  SERVER_STATE_UNREACHABLE,
  type SelectedServer,
  type ServerStatus,
} from "../../../../shared/server-discovery";

const mocks = vi.hoisted(() => ({
  onStatus: vi.fn(),
  unsubscribe: vi.fn(),
  current: vi.fn(),
  retry: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess },
}));

const { MOVED_NOTICE_STORAGE_KEY, useServerStatus } = await import("./use-server-status");

const saved: SelectedServer = {
  url: "http://192.168.1.20:13840",
  name: "设计部 Marvis",
  instanceId: "inst-design",
  source: SERVER_SOURCE_LAN,
  appUrl: "",
};

const MOVED_URL = "http://192.168.1.23:13840";

let pushStatus: (status: ServerStatus) => void = () => {};

function installDesktopAPI(
  options: { runtimeApiUrl?: string; saved?: SelectedServer | null } = {},
) {
  mocks.onStatus.mockReset().mockImplementation((callback: (status: ServerStatus) => void) => {
    pushStatus = callback;
    return mocks.unsubscribe;
  });
  mocks.unsubscribe.mockReset();
  mocks.current
    .mockReset()
    .mockResolvedValue(options.saved === undefined ? saved : options.saved);
  mocks.retry.mockReset();
  mocks.toastSuccess.mockReset();

  Object.defineProperty(window, "desktopAPI", {
    configurable: true,
    value: {
      runtimeConfig: {
        ok: true,
        config: {
          schemaVersion: 1,
          apiUrl: options.runtimeApiUrl ?? saved.url,
          wsUrl: "",
          appUrl: "",
        },
      },
      server: { onStatus: mocks.onStatus, current: mocks.current, retry: mocks.retry },
    },
  });
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="zh-Hans" resources={RESOURCES}>
      {children}
    </I18nProvider>
  );
}

async function mount() {
  const view = renderHook(() => useServerStatus(), { wrapper });
  // 等已保存的服务器读取落地。
  await act(async () => {});

  return view;
}

function push(status: ServerStatus) {
  act(() => pushStatus(status));
}

beforeEach(() => {
  sessionStorage.clear();
  installDesktopAPI();
});

describe("useServerStatus", () => {
  it("shows nothing while the server is online", async () => {
    const { result } = await mount();

    expect(result.current.banner).toBeNull();
    expect(result.current.replaced.open).toBe(false);

    push({ state: SERVER_STATE_ONLINE });
    expect(result.current.banner).toBeNull();
  });

  it("shows the reconnecting banner with the saved server name and address", async () => {
    const { result } = await mount();

    push({ state: SERVER_STATE_RECONNECTING });

    expect(result.current.banner).toBe(SERVER_STATE_RECONNECTING);
    expect(result.current.server).toEqual({ name: "设计部 Marvis", address: "192.168.1.20:13840" });
  });

  it("escalates to unreachable and hides again once online", async () => {
    const { result } = await mount();

    push({ state: SERVER_STATE_RECONNECTING });
    push({ state: SERVER_STATE_UNREACHABLE });
    expect(result.current.banner).toBe(SERVER_STATE_UNREACHABLE);

    push({ state: SERVER_STATE_ONLINE });
    expect(result.current.banner).toBeNull();
  });

  it("names a hand-written preset by its host until the saved server is known", async () => {
    installDesktopAPI({ runtimeApiUrl: "http://nas.local:13840", saved: null });
    const { result } = await mount();

    push({ state: SERVER_STATE_UNREACHABLE });

    expect(result.current.server).toEqual({ name: "nas.local:13840", address: "nas.local:13840" });
  });

  it("opens the replaced dialog over an unreachable banner, and waiting only closes the dialog", async () => {
    const { result } = await mount();

    push({ state: SERVER_STATE_REPLACED, otherName: "测试环境" });

    expect(result.current.banner).toBe(SERVER_STATE_UNREACHABLE);
    expect(result.current.replaced).toEqual({ open: true, otherName: "测试环境" });

    act(() => result.current.dismissReplaced());

    expect(result.current.replaced.open).toBe(false);
    expect(result.current.banner).toBe(SERVER_STATE_UNREACHABLE);
    // 对话框内容在关闭动画期间保留。
    expect(result.current.replaced.otherName).toBe("测试环境");
  });

  it("closes the replaced dialog when the server comes back or retrying starts", async () => {
    const { result } = await mount();

    push({ state: SERVER_STATE_REPLACED, otherName: "测试环境" });
    push({ state: SERVER_STATE_ONLINE });
    expect(result.current.replaced.open).toBe(false);
    expect(result.current.banner).toBeNull();

    push({ state: SERVER_STATE_REPLACED, otherName: "测试环境" });
    push({ state: SERVER_STATE_RECONNECTING });
    expect(result.current.replaced.open).toBe(false);
    expect(result.current.banner).toBe(SERVER_STATE_RECONNECTING);
  });

  it("forwards retry to the main process", async () => {
    const { result } = await mount();

    result.current.retry();

    expect(mocks.retry).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = await mount();

    unmount();

    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("works with a preload that has no server api", async () => {
    Object.defineProperty(window, "desktopAPI", { configurable: true, value: {} });

    const { result } = await mount();

    expect(result.current.banner).toBeNull();
    expect(() => result.current.retry()).not.toThrow();
  });
});

describe("moved notice", () => {
  it("clears the banner and remembers the new address for after the reload", async () => {
    const { result } = await mount();
    push({ state: SERVER_STATE_RECONNECTING });

    push({ state: SERVER_STATE_MOVED, url: MOVED_URL });

    expect(result.current.banner).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(MOVED_NOTICE_STORAGE_KEY)!)).toMatchObject({
      url: MOVED_URL,
    });
    // 窗口重载前不弹提示，重载后才弹，否则提示随页面一起消失。
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("shows the toast once after the reload and forgets the notice", async () => {
    sessionStorage.setItem(
      MOVED_NOTICE_STORAGE_KEY,
      JSON.stringify({ url: MOVED_URL, at: Date.now() }),
    );
    mocks.current.mockResolvedValue({ ...saved, url: MOVED_URL });

    await mount();

    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已重新连接到 设计部 Marvis", {
      description: "服务器地址变为 192.168.1.23:13840，已自动更新",
    });
    expect(sessionStorage.getItem(MOVED_NOTICE_STORAGE_KEY)).toBeNull();

    // 再挂载一次不会重复弹出。
    await mount();
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("drops a stale notice instead of showing it much later", async () => {
    sessionStorage.setItem(
      MOVED_NOTICE_STORAGE_KEY,
      JSON.stringify({ url: MOVED_URL, at: Date.now() - 10 * 60 * 1000 }),
    );

    await mount();

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(MOVED_NOTICE_STORAGE_KEY)).toBeNull();
  });

  it("ignores a corrupted notice", async () => {
    sessionStorage.setItem(MOVED_NOTICE_STORAGE_KEY, "{not json");

    await mount();

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
