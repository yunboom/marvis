// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { runtimeConfigFromServer } from "../shared/runtime-config";
import {
  SERVER_CURRENT,
  SERVER_DISCOVER,
  SERVER_DISCOVERED,
  SERVER_PROBE,
  SERVER_RESCAN,
  SERVER_RETRY,
  SERVER_SELECT,
  SERVER_STATUS,
  SERVER_STATUS_GET,
  type DiscoveredServer,
  type ProbeResult,
  type SelectedServer,
  type ServerStatus,
} from "../shared/server-discovery";
import type { LanBrowser } from "./lan-browser";
import {
  createServerController,
  registerServerIpc,
  type ServerIpcSender,
} from "./server-ipc";

const USER_DATA_DIR = "/data/Marvis";

const selected: SelectedServer = {
  url: "http://marvis.local:13840",
  name: "设计部 Marvis",
  instanceId: "inst-a",
  source: "lan",
  appUrl: "http://marvis.local:3000",
};

const discovered: DiscoveredServer = {
  url: "http://marvis.local:13840",
  name: "设计部 Marvis",
  version: "0.6.5",
  instanceId: "inst-a",
  host: "marvis.local",
  appUrl: "",
  isLocal: false,
  compatible: true,
};

function controllerSetup() {
  const calls: string[] = [];
  const writeSelected = vi.fn(async () => {
    calls.push("write");
  });
  const applyRuntimeConfig = vi.fn(() => {
    calls.push("apply");
  });
  const reloadAll = vi.fn(() => {
    calls.push("reload");
  });
  const readSelected = vi.fn(async () => null as SelectedServer | null);
  const probe = vi.fn(async (): Promise<ProbeResult> => ({ kind: "unreachable" }));

  const controller = createServerController({
    userDataDir: USER_DATA_DIR,
    probe,
    readSelected,
    writeSelected,
    applyRuntimeConfig,
    reloadAll,
  });

  return { controller, calls, writeSelected, applyRuntimeConfig, reloadAll, readSelected, probe };
}

describe("server controller", () => {
  it("select writes server.json and reloads windows", async () => {
    const t = controllerSetup();

    await t.controller.select(selected);

    expect(t.writeSelected).toHaveBeenCalledWith(USER_DATA_DIR, selected);
    expect(t.applyRuntimeConfig).toHaveBeenCalledWith({
      ok: true,
      config: runtimeConfigFromServer(selected),
    });
    expect(t.reloadAll).toHaveBeenCalledTimes(1);
    // 先落盘，再更新主进程持有的配置，最后才重载窗口。
    expect(t.calls).toEqual(["write", "apply", "reload"]);
  });

  it("select stores the normalized origin of the url", async () => {
    const t = controllerSetup();

    await t.controller.select({ ...selected, url: "HTTP://Marvis.Local:13840/login?x=1" });

    expect(t.writeSelected).toHaveBeenCalledWith(USER_DATA_DIR, selected);
  });

  it("select keeps a manual server without a web app", async () => {
    const t = controllerSetup();
    const manual: SelectedServer = { ...selected, source: "manual", appUrl: "" };

    await t.controller.select(manual);

    expect(t.writeSelected).toHaveBeenCalledWith(USER_DATA_DIR, manual);
    expect(t.applyRuntimeConfig).toHaveBeenCalledWith({
      ok: true,
      config: runtimeConfigFromServer(manual),
    });
  });

  it.each([
    ["not an object", "http://marvis.local:13840"],
    ["null", null],
    ["missing url", { ...selected, url: undefined }],
    ["non-http url", { ...selected, url: "ftp://marvis.local" }],
    ["unknown source", { ...selected, source: "dns" }],
    ["non-string name", { ...selected, name: 1 }],
    ["web app url that is not http(s)", { ...selected, appUrl: "javascript:alert(1)" }],
  ])("select rejects an invalid selection: %s", async (_label, value) => {
    const t = controllerSetup();

    await expect(t.controller.select(value as SelectedServer)).rejects.toThrow(
      "invalid server selection",
    );

    expect(t.writeSelected).not.toHaveBeenCalled();
    expect(t.applyRuntimeConfig).not.toHaveBeenCalled();
    expect(t.reloadAll).not.toHaveBeenCalled();
  });

  it("select does not touch the runtime config or windows when writing fails", async () => {
    const t = controllerSetup();
    t.writeSelected.mockRejectedValueOnce(new Error("disk full"));

    await expect(t.controller.select(selected)).rejects.toThrow("disk full");

    expect(t.applyRuntimeConfig).not.toHaveBeenCalled();
    expect(t.reloadAll).not.toHaveBeenCalled();
  });

  it("current returns the saved selection or null", async () => {
    const t = controllerSetup();

    expect(await t.controller.current()).toBeNull();

    t.readSelected.mockResolvedValueOnce(selected);

    expect(await t.controller.current()).toEqual(selected);
    expect(t.readSelected).toHaveBeenCalledWith(USER_DATA_DIR);
  });

  it("probe delegates to the probe and treats a non-string url as unreachable", async () => {
    const t = controllerSetup();
    const result: ProbeResult = { kind: "too_old" };
    t.probe.mockResolvedValueOnce(result);

    expect(await t.controller.probe("http://marvis.local:13840")).toEqual(result);
    expect(t.probe).toHaveBeenCalledWith("http://marvis.local:13840");

    expect(await t.controller.probe(42 as unknown as string)).toEqual({ kind: "unreachable" });
    expect(t.probe).toHaveBeenCalledTimes(1);
  });
});

type IpcEvent = { sender: ServerIpcSender };
type IpcListener = (event: IpcEvent, ...args: unknown[]) => unknown;

function fakeIpcMain() {
  const listeners = new Map<string, IpcListener>();
  const handlers = new Map<string, IpcListener>();

  return {
    on: (channel: string, listener: IpcListener) => {
      listeners.set(channel, listener);
    },
    handle: (channel: string, listener: IpcListener) => {
      handlers.set(channel, listener);
    },
    registeredChannels: () => [...listeners.keys(), ...handlers.keys()].sort(),
    emit: (channel: string, sender: ServerIpcSender, ...args: unknown[]) =>
      listeners.get(channel)?.({ sender }, ...args),
    invoke: (channel: string, sender: ServerIpcSender, ...args: unknown[]) =>
      handlers.get(channel)?.({ sender }, ...args),
  };
}

function fakeSender(id: number) {
  let destroyed = false;
  const onDestroyed: Array<() => void> = [];
  const sender: ServerIpcSender & { destroy: () => void } = {
    id,
    isDestroyed: () => destroyed,
    send: vi.fn(),
    once: (_event: "destroyed", listener: () => void) => {
      onDestroyed.push(listener);
    },
    destroy: () => {
      destroyed = true;
      for (const listener of onDestroyed) listener();
    },
  };

  return sender;
}

function ipcSetup() {
  const ipcMain = fakeIpcMain();
  let publish: (list: DiscoveredServer[]) => void = () => {};
  const lanBrowser: LanBrowser = {
    start: vi.fn((onChange: (list: DiscoveredServer[]) => void) => {
      publish = onChange;
    }),
    stop: vi.fn(),
    rescan: vi.fn(),
  };
  const writeSelected = vi.fn(async () => {});
  const reloadAll = vi.fn();
  const broadcast = vi.fn();
  const onRetry = vi.fn();
  const currentStatus = vi.fn((): ServerStatus => ({ state: "reconnecting" }));

  const api = registerServerIpc({
    ipcMain,
    userDataDir: USER_DATA_DIR,
    lanBrowser,
    probe: vi.fn(async (): Promise<ProbeResult> => ({ kind: "unreachable" })),
    readSelected: vi.fn(async () => selected),
    writeSelected,
    applyRuntimeConfig: vi.fn(),
    reloadAll,
    broadcast,
    onRetry,
    currentStatus,
  });

  return {
    ipcMain,
    lanBrowser,
    api,
    writeSelected,
    reloadAll,
    broadcast,
    onRetry,
    currentStatus,
    publish: (list: DiscoveredServer[]) => publish(list),
  };
}

describe("registerServerIpc", () => {
  it("registers every server channel", () => {
    const t = ipcSetup();

    expect(t.ipcMain.registeredChannels()).toEqual(
      [
        SERVER_CURRENT,
        SERVER_DISCOVER,
        SERVER_PROBE,
        SERVER_RESCAN,
        SERVER_RETRY,
        SERVER_SELECT,
        SERVER_STATUS_GET,
      ].sort(),
    );
  });

  it("starts browsing on the first subscriber and pushes every change to it", () => {
    const t = ipcSetup();
    const window1 = fakeSender(1);

    t.ipcMain.emit(SERVER_DISCOVER, window1, true);

    expect(t.lanBrowser.start).toHaveBeenCalledTimes(1);
    expect(window1.send).toHaveBeenCalledWith(SERVER_DISCOVERED, []);

    t.publish([discovered]);

    expect(window1.send).toHaveBeenLastCalledWith(SERVER_DISCOVERED, [discovered]);
  });

  it("shares one browse between windows and replays the latest list to a late subscriber", () => {
    const t = ipcSetup();
    const window1 = fakeSender(1);
    const window2 = fakeSender(2);

    t.ipcMain.emit(SERVER_DISCOVER, window1, true);
    t.publish([discovered]);
    t.ipcMain.emit(SERVER_DISCOVER, window2, true);

    expect(t.lanBrowser.start).toHaveBeenCalledTimes(1);
    expect(window2.send).toHaveBeenCalledWith(SERVER_DISCOVERED, [discovered]);
  });

  it("does not subscribe the same window twice", () => {
    const t = ipcSetup();
    const window1 = fakeSender(1);

    t.ipcMain.emit(SERVER_DISCOVER, window1, true);
    t.ipcMain.emit(SERVER_DISCOVER, window1, true);
    window1.send = vi.fn();
    t.publish([discovered]);

    expect(window1.send).toHaveBeenCalledTimes(1);
  });

  it("stops browsing when the last subscriber leaves", () => {
    const t = ipcSetup();
    const window1 = fakeSender(1);
    const window2 = fakeSender(2);
    t.ipcMain.emit(SERVER_DISCOVER, window1, true);
    t.ipcMain.emit(SERVER_DISCOVER, window2, true);

    t.ipcMain.emit(SERVER_DISCOVER, window1, false);
    expect(t.lanBrowser.stop).not.toHaveBeenCalled();

    t.ipcMain.emit(SERVER_DISCOVER, window2, false);
    expect(t.lanBrowser.stop).toHaveBeenCalledTimes(1);
  });

  it("drops a destroyed window and never sends to it", () => {
    const t = ipcSetup();
    const window1 = fakeSender(1);
    t.ipcMain.emit(SERVER_DISCOVER, window1, true);

    window1.destroy();

    expect(t.lanBrowser.stop).toHaveBeenCalledTimes(1);
    window1.send = vi.fn();
    t.publish([discovered]);
    expect(window1.send).not.toHaveBeenCalled();
  });

  it("ignores a discover message whose payload is not a boolean", () => {
    const t = ipcSetup();

    t.ipcMain.emit(SERVER_DISCOVER, fakeSender(1), "yes");

    expect(t.lanBrowser.start).not.toHaveBeenCalled();
  });

  it("forwards rescan and retry", () => {
    const t = ipcSetup();

    t.ipcMain.emit(SERVER_RESCAN, fakeSender(1));
    t.ipcMain.emit(SERVER_RETRY, fakeSender(1));

    expect(t.lanBrowser.rescan).toHaveBeenCalledTimes(1);
    expect(t.onRetry).toHaveBeenCalledTimes(1);
  });

  it("select through ipc writes, reloads and stops discovery for the reloaded windows", async () => {
    const t = ipcSetup();
    const window1 = fakeSender(1);
    t.ipcMain.emit(SERVER_DISCOVER, window1, true);

    await t.ipcMain.invoke(SERVER_SELECT, window1, selected);

    expect(t.writeSelected).toHaveBeenCalledWith(USER_DATA_DIR, selected);
    expect(t.reloadAll).toHaveBeenCalledTimes(1);
    // 窗口重载后旧页面的订阅已失效，不再向它们推送。
    expect(t.lanBrowser.stop).toHaveBeenCalledTimes(1);
  });

  it("answers current through ipc", async () => {
    const t = ipcSetup();

    expect(await t.ipcMain.invoke(SERVER_CURRENT, fakeSender(1))).toEqual(selected);
  });

  it("answers the current connection status so a new window can catch up", async () => {
    const t = ipcSetup();

    expect(await t.ipcMain.invoke(SERVER_STATUS_GET, fakeSender(1))).toEqual({
      state: "reconnecting",
    });
  });

  it("reports online when no status source is wired", async () => {
    const ipcMain = fakeIpcMain();
    registerServerIpc({
      ipcMain,
      userDataDir: USER_DATA_DIR,
      lanBrowser: { start: vi.fn(), stop: vi.fn(), rescan: vi.fn() },
      probe: vi.fn(async (): Promise<ProbeResult> => ({ kind: "unreachable" })),
      readSelected: vi.fn(async () => null),
      writeSelected: vi.fn(async () => {}),
      applyRuntimeConfig: vi.fn(),
      reloadAll: vi.fn(),
      broadcast: vi.fn(),
    });

    expect(await ipcMain.invoke(SERVER_STATUS_GET, fakeSender(1))).toEqual({ state: "online" });
  });

  it("publishStatus broadcasts to every window", () => {
    const t = ipcSetup();
    const status: ServerStatus = { state: "moved", url: "http://192.168.1.30:13840" };

    t.api.publishStatus(status);

    expect(t.broadcast).toHaveBeenCalledWith(SERVER_STATUS, status);
  });
});
