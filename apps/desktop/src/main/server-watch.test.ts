// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SERVER_SOURCE_LAN,
  SERVER_STATE_MOVED,
  SERVER_STATE_ONLINE,
  SERVER_STATE_RECONNECTING,
  SERVER_STATE_REPLACED,
  SERVER_STATE_UNREACHABLE,
  type DiscoveredServer,
  type ProbeResult,
  type SelectedServer,
  type ServerIdentity,
  type ServerStatus,
} from "../shared/server-discovery";
import {
  createServerWatch,
  WATCH_ONLINE_INTERVAL_MS,
  WATCH_RECONNECT_INTERVAL_MS,
  WATCH_UNREACHABLE_INTERVAL_MS,
  type ServerWatchDeps,
} from "./server-watch";

const SAVED_URL = "http://192.168.1.20:13840";
const MOVED_URL = "http://192.168.1.23:13840";

const selected: SelectedServer = {
  url: SAVED_URL,
  name: "设计部 Marvis",
  instanceId: "inst-design",
  source: SERVER_SOURCE_LAN,
  appUrl: "http://192.168.1.20:3000",
};

// 手写预设：没有保存过身份，只做在线 / 重连 / 不可达判断。
const preset: SelectedServer = { ...selected, instanceId: "", name: "192.168.1.20:13840" };

function identity(overrides: Partial<ServerIdentity> = {}): ServerIdentity {
  const url = overrides.url ?? SAVED_URL;

  return {
    url,
    name: "设计部 Marvis",
    version: "v0.6.5",
    instanceId: "inst-design",
    host: new URL(url).hostname,
    appUrl: "",
    ...overrides,
  };
}

function ok(overrides: Partial<ServerIdentity> = {}): ProbeResult {
  return { kind: "ok", server: identity(overrides) };
}

const down: ProbeResult = { kind: "unreachable" };

function lanServer(overrides: Partial<DiscoveredServer> = {}): DiscoveredServer {
  return { ...identity(), isLocal: false, compatible: true, ...overrides };
}

// 按顺序给出探测结果；用完后一直返回最后一个。
function scriptedProbe(results: ProbeResult[]) {
  let index = 0;

  return vi.fn(async (_url: string): Promise<ProbeResult> => {
    const result = results[Math.min(index, results.length - 1)]!;
    index += 1;

    return result;
  });
}

function setup(options: {
  selected?: SelectedServer;
  probe: ServerWatchDeps["probe"];
  discovered?: () => DiscoveredServer[];
  save?: ServerWatchDeps["save"];
}) {
  const emitted: ServerStatus[] = [];
  const save = options.save ?? vi.fn(async () => {});
  const discovered = vi.fn(options.discovered ?? (() => []));

  const watch = createServerWatch({
    selected: options.selected ?? selected,
    probe: options.probe,
    discovered,
    save,
    emit: (status) => emitted.push(status),
  });

  return { watch, emitted, save, discovered };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("server watch transitions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("online -> reconnecting -> unreachable -> online with fake timers", async () => {
    const probe = scriptedProbe([ok(), down, down, down, ok()]);
    const { watch, emitted } = setup({ probe });

    // 启动后立刻探测一次，在线不发事件。
    watch.start();
    await advance(0);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([]);

    // 在线时每 10 秒一次；第一次失败切到重连。
    await advance(WATCH_ONLINE_INTERVAL_MS - 1);
    expect(probe).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(emitted).toEqual([{ state: SERVER_STATE_RECONNECTING }]);

    // 重连时每 3 秒一次；第二次失败仍是重连，第三次失败切到不可达。
    await advance(WATCH_RECONNECT_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(emitted).toEqual([{ state: SERVER_STATE_RECONNECTING }]);
    await advance(WATCH_RECONNECT_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(emitted).toEqual([
      { state: SERVER_STATE_RECONNECTING },
      { state: SERVER_STATE_UNREACHABLE },
    ]);

    // 不可达后每 15 秒一次，恢复后发出在线。
    await advance(WATCH_UNREACHABLE_INTERVAL_MS - 1);
    expect(probe).toHaveBeenCalledTimes(4);
    await advance(1);
    expect(probe).toHaveBeenCalledTimes(5);
    expect(emitted).toEqual([
      { state: SERVER_STATE_RECONNECTING },
      { state: SERVER_STATE_UNREACHABLE },
      { state: SERVER_STATE_ONLINE },
    ]);

    // 回到在线后恢复 10 秒的间隔。
    await advance(WATCH_ONLINE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(6);
  });

  it("emits each state once, not on every failed probe", async () => {
    const probe = scriptedProbe([down]);
    const { watch, emitted } = setup({ probe });

    watch.start();
    // 一分钟内持续失败：重连一次、不可达一次，其余探测都不再重复发事件。
    await advance(60_000);

    expect(probe.mock.calls.length).toBeGreaterThan(5);
    expect(emitted).toEqual([
      { state: SERVER_STATE_RECONNECTING },
      { state: SERVER_STATE_UNREACHABLE },
    ]);
  });

  it("counts the probe duration towards the interval", async () => {
    // 探测本身耗时 2 秒：下一次仍按固定间隔发起，而不是 间隔 + 耗时。
    const probe = vi.fn(
      () =>
        new Promise<ProbeResult>((resolve) => {
          setTimeout(() => resolve(ok()), 2000);
        }),
    );
    const { watch } = setup({ probe });

    watch.start();
    await advance(0);
    expect(probe).toHaveBeenCalledTimes(1);

    await advance(WATCH_ONLINE_INTERVAL_MS - 1);
    expect(probe).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("follows the same instance to a new address and saves it", async () => {
    const probe = scriptedProbe([down, ok({ url: MOVED_URL })]);
    const { watch, emitted, save } = setup({
      probe,
      discovered: () => [lanServer({ url: MOVED_URL })],
    });

    watch.start();
    await advance(0);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ ...selected, url: MOVED_URL });
    expect(emitted).toEqual([{ state: SERVER_STATE_MOVED, url: MOVED_URL }]);

    // 之后探测新地址。
    await advance(WATCH_ONLINE_INTERVAL_MS);
    expect(probe).toHaveBeenLastCalledWith(MOVED_URL);
  });

  it("goes through reconnecting first when the new address shows up later", async () => {
    const probe = scriptedProbe([down]);
    let list: DiscoveredServer[] = [];
    const { watch, emitted, save } = setup({ probe, discovered: () => list });

    watch.start();
    await advance(0);
    expect(emitted).toEqual([{ state: SERVER_STATE_RECONNECTING }]);
    expect(save).not.toHaveBeenCalled();

    list = [lanServer({ url: MOVED_URL })];
    await advance(WATCH_RECONNECT_INTERVAL_MS);

    expect(save).toHaveBeenCalledWith({ ...selected, url: MOVED_URL });
    expect(emitted).toEqual([
      { state: SERVER_STATE_RECONNECTING },
      { state: SERVER_STATE_MOVED, url: MOVED_URL },
    ]);
  });

  it("does not follow a different instance, an incompatible entry, or the saved address", async () => {
    const probe = scriptedProbe([down]);
    const { watch, save } = setup({
      probe,
      discovered: () => [
        lanServer({ url: MOVED_URL, instanceId: "inst-other" }),
        lanServer({ url: MOVED_URL, compatible: false }),
        lanServer({ url: SAVED_URL }),
      ],
    });

    watch.start();
    await advance(30_000);

    expect(save).not.toHaveBeenCalled();
  });

  it("keeps reconnecting when saving the moved address fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const save = vi.fn(async () => {
      throw new Error("disk full");
    });
    const probe = scriptedProbe([down]);
    const { watch, emitted } = setup({
      probe,
      save,
      discovered: () => [lanServer({ url: MOVED_URL })],
    });

    watch.start();
    await advance(0);

    expect(emitted).toEqual([{ state: SERVER_STATE_RECONNECTING }]);

    // 下一轮探测仍然探测旧地址，并再次尝试保存。
    await advance(WATCH_RECONNECT_INTERVAL_MS);
    expect(probe).toHaveBeenLastCalledWith(SAVED_URL);
    expect(save).toHaveBeenCalledTimes(2);

    warn.mockRestore();
  });

  it("does not switch when another instance answers at the saved address", async () => {
    const probe = scriptedProbe([ok({ instanceId: "inst-test", name: "测试环境" })]);
    const { watch, emitted, save } = setup({ probe });

    watch.start();
    await advance(0);

    expect(emitted).toEqual([{ state: SERVER_STATE_REPLACED, otherName: "测试环境" }]);
    expect(save).not.toHaveBeenCalled();

    // 对方一直占着这个地址：不重复发事件，改按 15 秒的间隔探测。
    await advance(WATCH_UNREACHABLE_INTERVAL_MS * 3);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(emitted).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("prefers following the moved instance over reporting a replacement", async () => {
    // 原服务器搬到了新地址，旧地址被另一台服务器占用。
    const probe = scriptedProbe([ok({ instanceId: "inst-test", name: "测试环境" })]);
    const { watch, emitted, save } = setup({
      probe,
      discovered: () => [lanServer({ url: MOVED_URL })],
    });

    watch.start();
    await advance(0);

    expect(save).toHaveBeenCalledWith({ ...selected, url: MOVED_URL });
    expect(emitted).toEqual([{ state: SERVER_STATE_MOVED, url: MOVED_URL }]);
  });

  it("recovers to online when the saved instance answers again after a replacement", async () => {
    const probe = scriptedProbe([ok({ instanceId: "inst-test", name: "测试环境" }), ok()]);
    const { watch, emitted } = setup({ probe });

    watch.start();
    await advance(0);
    await advance(WATCH_UNREACHABLE_INTERVAL_MS);

    expect(emitted).toEqual([
      { state: SERVER_STATE_REPLACED, otherName: "测试环境" },
      { state: SERVER_STATE_ONLINE },
    ]);
  });

  it("falls back to unreachable when the other instance goes away", async () => {
    const probe = scriptedProbe([ok({ instanceId: "inst-test", name: "测试环境" }), down]);
    const { watch, emitted } = setup({ probe });

    watch.start();
    await advance(0);
    await advance(WATCH_UNREACHABLE_INTERVAL_MS);

    expect(emitted).toEqual([
      { state: SERVER_STATE_REPLACED, otherName: "测试环境" },
      { state: SERVER_STATE_UNREACHABLE },
    ]);
  });

  it("treats a non-Marvis or too-old answer as down for a saved server", async () => {
    const probe = scriptedProbe([{ kind: "not_marvis" }, { kind: "too_old" }]);
    const { watch, emitted } = setup({ probe });

    watch.start();
    await advance(0);
    expect(emitted).toEqual([{ state: SERVER_STATE_RECONNECTING }]);

    // 第二次是版本过旧的应答：同样不是原服务器，仍在重连。
    await advance(WATCH_RECONNECT_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(emitted).toEqual([{ state: SERVER_STATE_RECONNECTING }]);
  });
});

describe("server watch for a hand-written preset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("only reports reconnecting, unreachable and online", async () => {
    const probe = scriptedProbe([down, down, down, ok()]);
    const { watch, emitted, save, discovered } = setup({ selected: preset, probe });

    watch.start();
    await advance(WATCH_RECONNECT_INTERVAL_MS * 2);
    await advance(WATCH_UNREACHABLE_INTERVAL_MS);

    expect(emitted).toEqual([
      { state: SERVER_STATE_RECONNECTING },
      { state: SERVER_STATE_UNREACHABLE },
      { state: SERVER_STATE_ONLINE },
    ]);
    expect(discovered).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("treats any answer as reachable and never reports a replacement", async () => {
    const probe = scriptedProbe([
      ok({ instanceId: "inst-whatever", name: "别的服务器" }),
      { kind: "too_old" },
      { kind: "not_marvis" },
    ]);
    const { watch, emitted } = setup({ selected: preset, probe });

    watch.start();
    await advance(WATCH_ONLINE_INTERVAL_MS * 2);

    expect(probe).toHaveBeenCalledTimes(3);
    expect(emitted).toEqual([]);
  });
});

describe("server watch controls", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retryNow probes immediately and restarts the interval", async () => {
    const probe = scriptedProbe([ok(), ok()]);
    const { watch } = setup({ probe });

    watch.start();
    await advance(0);
    await advance(4000);
    expect(probe).toHaveBeenCalledTimes(1);

    watch.retryNow();
    await advance(0);
    expect(probe).toHaveBeenCalledTimes(2);

    // 间隔从重试那一刻重新计时。
    await advance(WATCH_ONLINE_INTERVAL_MS - 1);
    expect(probe).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("retryNow from unreachable shows reconnecting again and recovers on success", async () => {
    const probe = scriptedProbe([down, down, down, ok()]);
    const { watch, emitted } = setup({ probe });

    watch.start();
    await advance(WATCH_RECONNECT_INTERVAL_MS * 2);
    expect(emitted).toEqual([
      { state: SERVER_STATE_RECONNECTING },
      { state: SERVER_STATE_UNREACHABLE },
    ]);

    watch.retryNow();
    await advance(0);

    expect(emitted).toEqual([
      { state: SERVER_STATE_RECONNECTING },
      { state: SERVER_STATE_UNREACHABLE },
      { state: SERVER_STATE_RECONNECTING },
      { state: SERVER_STATE_ONLINE },
    ]);
  });

  it("stop cancels the timer and drops a probe that is still in flight", async () => {
    let finish: (result: ProbeResult) => void = () => {};
    const probe = vi.fn(
      () =>
        new Promise<ProbeResult>((resolve) => {
          finish = resolve;
        }),
    );
    const { watch, emitted } = setup({ probe });

    watch.start();
    await advance(0);
    watch.stop();
    finish(down);
    await advance(WATCH_ONLINE_INTERVAL_MS * 3);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([]);
  });

  it("retryNow after stop does nothing", async () => {
    const probe = scriptedProbe([ok()]);
    const { watch } = setup({ probe });

    watch.start();
    await advance(0);
    watch.stop();
    watch.retryNow();
    await advance(WATCH_ONLINE_INTERVAL_MS);

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("start twice does not run two loops", async () => {
    const probe = scriptedProbe([ok()]);
    const { watch } = setup({ probe });

    watch.start();
    watch.start();
    await advance(WATCH_ONLINE_INTERVAL_MS);

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("keeps running when the probe throws", async () => {
    const probe = vi.fn(async (): Promise<ProbeResult> => {
      throw new Error("boom");
    });
    const { watch, emitted } = setup({ probe });

    watch.start();
    await advance(WATCH_RECONNECT_INTERVAL_MS);

    expect(probe).toHaveBeenCalledTimes(2);
    expect(emitted).toEqual([{ state: SERVER_STATE_RECONNECTING }]);
  });
});
