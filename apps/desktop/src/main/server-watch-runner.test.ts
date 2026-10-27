// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeConfigFromServer, type RuntimeConfigResult } from "../shared/runtime-config";
import {
  SERVER_SOURCE_LAN,
  SERVER_SOURCE_MANUAL,
  SERVER_STATE_MOVED,
  SERVER_STATE_ONLINE,
  SERVER_STATE_RECONNECTING,
  type DiscoveredServer,
  type ProbeResult,
  type SelectedServer,
  type ServerStatus,
} from "../shared/server-discovery";
import type { LanBrowser } from "./lan-browser";
import {
  createServerWatchRunner,
  MOVED_RELOAD_DELAY_MS,
  resolveWatchTarget,
} from "./server-watch-runner";
import { WATCH_ONLINE_INTERVAL_MS, WATCH_RECONNECT_INTERVAL_MS } from "./server-watch";

const USER_DATA_DIR = "/data/Marvis";
const SAVED_URL = "http://192.168.1.20:13840";
const MOVED_URL = "http://192.168.1.23:13840";

const selected: SelectedServer = {
  url: SAVED_URL,
  name: "设计部 Marvis",
  instanceId: "inst-design",
  source: SERVER_SOURCE_LAN,
  appUrl: "http://192.168.1.20:3000",
};

function configFor(apiUrl: string, appUrl = ""): RuntimeConfigResult {
  return {
    ok: true,
    config: { schemaVersion: 1, apiUrl, wsUrl: apiUrl.replace("http", "ws"), appUrl },
  };
}

const ok = (url: string, instanceId = "inst-design"): ProbeResult => ({
  kind: "ok",
  server: {
    url,
    name: "设计部 Marvis",
    version: "v0.6.5",
    instanceId,
    host: new URL(url).hostname,
    appUrl: "",
  },
});
const down: ProbeResult = { kind: "unreachable" };

function lanServer(url: string): DiscoveredServer {
  return {
    url,
    name: "设计部 Marvis",
    version: "v0.6.5",
    instanceId: "inst-design",
    host: new URL(url).hostname,
    appUrl: "",
    isLocal: false,
    compatible: true,
  };
}

function setup(
  options: {
    runtime?: RuntimeConfigResult;
    saved?: SelectedServer | null;
    probe?: (url: string) => Promise<ProbeResult>;
  } = {},
) {
  let runtime = options.runtime ?? configFor(SAVED_URL);
  let publishList: (list: DiscoveredServer[]) => void = () => {};
  const lanBrowser: LanBrowser = {
    start: vi.fn((onChange: (list: DiscoveredServer[]) => void) => {
      publishList = onChange;
    }),
    stop: vi.fn(),
    rescan: vi.fn(),
  };
  const probe = vi.fn(options.probe ?? (async (): Promise<ProbeResult> => down));
  const published: ServerStatus[] = [];
  const writeSelected = vi.fn(async () => {});
  const applyRuntimeConfig = vi.fn((result: RuntimeConfigResult) => {
    runtime = result;
  });
  const reloadAll = vi.fn();
  const readSelected = vi.fn(async () =>
    options.saved === undefined ? selected : options.saved,
  );

  const runner = createServerWatchRunner({
    userDataDir: USER_DATA_DIR,
    getRuntimeConfig: () => runtime,
    readSelected,
    writeSelected,
    applyRuntimeConfig,
    probe,
    lanBrowser,
    publish: (status) => published.push(status),
    reloadAll,
  });

  return {
    runner,
    lanBrowser,
    probe,
    published,
    writeSelected,
    applyRuntimeConfig,
    reloadAll,
    readSelected,
    setRuntime: (next: RuntimeConfigResult) => {
      runtime = next;
    },
    publishList: (list: DiscoveredServer[]) => publishList(list),
  };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("resolveWatchTarget", () => {
  it("watches the saved selection when it is the server in use", () => {
    expect(resolveWatchTarget(configFor(SAVED_URL), selected)).toEqual(selected);
  });

  it("falls back to the runtime config address when nothing is saved", () => {
    const target = resolveWatchTarget(configFor("http://nas.local:13840", "http://nas.local:3000"), null);

    expect(target).toEqual({
      url: "http://nas.local:13840",
      name: "nas.local:13840",
      instanceId: "",
      source: SERVER_SOURCE_MANUAL,
      appUrl: "http://nas.local:3000",
    });
  });

  it("watches the address actually in use when it differs from the saved selection", () => {
    const target = resolveWatchTarget(configFor("http://localhost:13840"), selected);

    expect(target?.url).toBe("http://localhost:13840");
    expect(target?.instanceId).toBe("");
  });

  it("returns null while no server is configured", () => {
    expect(resolveWatchTarget({ ok: false, unconfigured: true }, null)).toBeNull();
    expect(resolveWatchTarget({ ok: false, error: { message: "bad" } }, selected)).toBeNull();
  });
});

describe("server watch runner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start a watch on the connect screen", async () => {
    const t = setup({ runtime: { ok: false, unconfigured: true }, saved: null });

    await t.runner.restart();
    await advance(WATCH_ONLINE_INTERVAL_MS * 2);

    expect(t.probe).not.toHaveBeenCalled();
    expect(t.published).toEqual([]);
  });

  it("probes the saved server and publishes transitions", async () => {
    const t = setup();

    await t.runner.restart();
    await advance(0);

    expect(t.probe).toHaveBeenCalledWith(SAVED_URL);
    expect(t.published).toEqual([{ state: SERVER_STATE_RECONNECTING }]);
    expect(t.runner.currentStatus()).toEqual({ state: SERVER_STATE_RECONNECTING });
  });

  it("watches the runtime config address of a hand-written preset without identity checks", async () => {
    const t = setup({ runtime: configFor("http://nas.local:13840"), saved: null });

    await t.runner.restart();
    await advance(0);

    expect(t.probe).toHaveBeenCalledWith("http://nas.local:13840");
    expect(t.published).toEqual([{ state: SERVER_STATE_RECONNECTING }]);
    // 没有身份可比对，不需要局域网浏览。
    expect(t.lanBrowser.start).not.toHaveBeenCalled();
  });

  it("browses the LAN only while the server is not online", async () => {
    const results = [ok(SAVED_URL), down, ok(SAVED_URL)];
    let index = 0;
    const t = setup({ probe: async () => results[Math.min(index++, results.length - 1)]! });

    await t.runner.restart();
    await advance(0);
    expect(t.lanBrowser.start).not.toHaveBeenCalled();

    // 掉线后开始浏览。
    await advance(WATCH_ONLINE_INTERVAL_MS);
    expect(t.lanBrowser.start).toHaveBeenCalledTimes(1);
    expect(t.lanBrowser.stop).not.toHaveBeenCalled();

    // 恢复在线后停止。
    await advance(WATCH_RECONNECT_INTERVAL_MS);
    expect(t.published).toEqual([
      { state: SERVER_STATE_RECONNECTING },
      { state: SERVER_STATE_ONLINE },
    ]);
    expect(t.lanBrowser.stop).toHaveBeenCalledTimes(1);
  });

  it("follows a moved server: saves, updates the runtime config, then reloads after the notice", async () => {
    const t = setup();

    await t.runner.restart();
    await advance(0);
    t.publishList([lanServer(MOVED_URL)]);
    await advance(WATCH_RECONNECT_INTERVAL_MS);

    const next = { ...selected, url: MOVED_URL };
    expect(t.writeSelected).toHaveBeenCalledWith(USER_DATA_DIR, next);
    expect(t.applyRuntimeConfig).toHaveBeenCalledWith({
      ok: true,
      config: runtimeConfigFromServer(next),
    });
    expect(t.published.at(-1)).toEqual({ state: SERVER_STATE_MOVED, url: MOVED_URL });
    expect(t.lanBrowser.stop).toHaveBeenCalledTimes(1);

    // moved 只通知一次：新窗口问当前状态时已经是在线。
    expect(t.runner.currentStatus()).toEqual({ state: SERVER_STATE_ONLINE });

    // 先让界面收下通知，再重载窗口，新窗口按新地址启动。
    expect(t.reloadAll).not.toHaveBeenCalled();
    await advance(MOVED_RELOAD_DELAY_MS);
    expect(t.reloadAll).toHaveBeenCalledTimes(1);

    // 之后监测新地址。
    await advance(WATCH_ONLINE_INTERVAL_MS);
    expect(t.probe).toHaveBeenLastCalledWith(MOVED_URL);
  });

  it("restart switches the watch to the newly selected server", async () => {
    const t = setup({ probe: async () => ok(SAVED_URL) });

    await t.runner.restart();
    await advance(0);
    expect(t.probe).toHaveBeenLastCalledWith(SAVED_URL);

    const other: SelectedServer = { ...selected, url: MOVED_URL, instanceId: "inst-other" };
    t.readSelected.mockResolvedValue(other);
    t.setRuntime(configFor(MOVED_URL));
    t.probe.mockClear();

    await t.runner.restart();
    await advance(WATCH_ONLINE_INTERVAL_MS * 2);

    // 旧地址不再被探测。
    const urls = new Set(t.probe.mock.calls.map(([url]) => url));
    expect([...urls]).toEqual([MOVED_URL]);
  });

  it("restart clears a pending outage", async () => {
    const t = setup();

    await t.runner.restart();
    await advance(0);
    expect(t.runner.currentStatus()).toEqual({ state: SERVER_STATE_RECONNECTING });

    t.probe.mockResolvedValue(ok(SAVED_URL));
    await t.runner.restart();

    expect(t.runner.currentStatus()).toEqual({ state: SERVER_STATE_ONLINE });
    expect(t.lanBrowser.stop).toHaveBeenCalled();
  });

  it("lets only the latest of two overlapping restarts start a watch", async () => {
    const t = setup({ probe: async () => ok(SAVED_URL) });

    await Promise.all([t.runner.restart(), t.runner.restart()]);
    await advance(WATCH_ONLINE_INTERVAL_MS);

    // 只有一个循环在跑：启动时一次，10 秒后一次。
    expect(t.probe).toHaveBeenCalledTimes(2);
  });

  it("retryNow reaches the running watch and is a no-op without one", async () => {
    const idle = setup({ runtime: { ok: false, unconfigured: true }, saved: null });
    await idle.runner.restart();
    expect(() => idle.runner.retryNow()).not.toThrow();

    const t = setup({ probe: async () => ok(SAVED_URL) });
    await t.runner.restart();
    await advance(0);
    t.runner.retryNow();
    await advance(0);

    expect(t.probe).toHaveBeenCalledTimes(2);
  });

  it("stop ends the watch and the LAN browse", async () => {
    const t = setup();

    await t.runner.restart();
    await advance(0);
    t.runner.stop();
    t.probe.mockClear();
    await advance(WATCH_ONLINE_INTERVAL_MS * 3);

    expect(t.probe).not.toHaveBeenCalled();
    expect(t.lanBrowser.stop).toHaveBeenCalled();
  });
});
