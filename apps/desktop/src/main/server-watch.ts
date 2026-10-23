import {
  normalizeServerAddress,
  SERVER_STATE_MOVED,
  SERVER_STATE_ONLINE,
  SERVER_STATE_RECONNECTING,
  SERVER_STATE_REPLACED,
  SERVER_STATE_UNREACHABLE,
  type DiscoveredServer,
  type ProbeResult,
  type SelectedServer,
  type ServerStatus,
} from "../shared/server-discovery";
import type { probeServer } from "./server-probe";

// 探测间隔：在线 10 秒；失败后进入重连，每 3 秒；连续失败达到上限后判定不可达，每 15 秒。
export const WATCH_ONLINE_INTERVAL_MS = 10_000;
export const WATCH_RECONNECT_INTERVAL_MS = 3_000;
export const WATCH_UNREACHABLE_INTERVAL_MS = 15_000;
export const WATCH_FAILURES_BEFORE_UNREACHABLE = 3;

export interface ServerWatchDeps {
  // 被监测的服务器。instanceId 为空串表示只知道地址（手写预设），
  // 此时只判断在线 / 重连 / 不可达，不做搬迁和换机检测。
  selected: SelectedServer;
  probe: typeof probeServer;
  // 局域网浏览当前发现的服务器，用来找同一实例的新地址。
  discovered: () => DiscoveredServer[];
  // 跟随到新地址后保存新的选择。
  save: (selected: SelectedServer) => Promise<void>;
  emit: (status: ServerStatus) => void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface ServerWatch {
  start(): void;
  stop(): void;
  // 立即探测一次并重新计时；已经不可达时先回到重连，让界面有反馈。
  retryNow(): void;
}

// 当前所处的阶段。replaced 表示保存的地址上是另一台服务器在应答。
type Phase =
  | typeof SERVER_STATE_ONLINE
  | typeof SERVER_STATE_RECONNECTING
  | typeof SERVER_STATE_UNREACHABLE
  | typeof SERVER_STATE_REPLACED;

// 一次探测的判定。
type Verdict =
  | { kind: "up" }
  | { kind: "other"; name: string }
  | { kind: "down" };

const VERDICT_UP: Verdict = { kind: "up" };
const VERDICT_DOWN: Verdict = { kind: "down" };

// 监测已选服务器的连接状态，只在状态变化时发出一次事件。
//   - 保存的地址不通时，到局域网发现的列表里找同一实例的新地址，找到就保存并发出 moved；
//   - 保存的地址上是另一台服务器应答时发出 replaced，绝不自动切换。
export function createServerWatch(deps: ServerWatchDeps): ServerWatch {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;

  let selected = deps.selected;
  let phase: Phase = SERVER_STATE_ONLINE;
  // phase 为 replaced 时对方的名称，换了一台新的对方要重新提示。
  let otherName = "";
  let failures = 0;
  let running = false;
  // 每次启动、停止、重试加一，用来丢弃上一轮遗留的探测结果和定时器。
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 最近一次发出的状态的键，相同的状态不重复发出。
  let emittedKey: string = SERVER_STATE_ONLINE;

  const tracksIdentity = (): boolean => selected.instanceId !== "";

  function judge(result: ProbeResult): Verdict {
    // 没有身份可比对时，只要对方有应答就算在线。
    if (!tracksIdentity()) {
      return result.kind === "unreachable" ? VERDICT_DOWN : VERDICT_UP;
    }

    if (result.kind !== "ok") return VERDICT_DOWN;
    if (result.server.instanceId === selected.instanceId) return VERDICT_UP;

    return { kind: "other", name: result.server.name };
  }

  async function probeSelected(): Promise<ProbeResult> {
    try {
      return await deps.probe(selected.url);
    } catch {
      // probeServer 自身不会抛错，这里兜底桩或将来替换的实现。
      return { kind: "unreachable" };
    }
  }

  // 局域网发现的列表里同一实例的新地址；列表里的条目已经过 /api/config 核实。
  function findMoved(): DiscoveredServer | undefined {
    if (!tracksIdentity()) return undefined;

    const current = normalizeServerAddress(selected.url);

    return deps
      .discovered()
      .find(
        (server) =>
          server.compatible &&
          server.instanceId === selected.instanceId &&
          normalizeServerAddress(server.url) !== current,
      );
  }

  // 找到同一实例的新地址就保存并跟随，返回新地址；没有或保存失败时返回 null。
  async function followMoved(): Promise<string | null> {
    const moved = findMoved();
    if (!moved) return null;

    const next: SelectedServer = { ...selected, url: moved.url };
    try {
      await deps.save(next);
    } catch (err) {
      // 定时器回调里没有上层可以接住错误；留在重连状态，下一轮再试。
      console.warn("[server-watch] failed to save the moved server:", err);

      return null;
    }

    selected = next;

    return moved.url;
  }

  function keyOf(next: Phase): string {
    return next === SERVER_STATE_REPLACED ? `${SERVER_STATE_REPLACED}:${otherName}` : next;
  }

  function statusOf(next: Phase): ServerStatus {
    if (next === SERVER_STATE_REPLACED) {
      return { state: SERVER_STATE_REPLACED, otherName };
    }

    return { state: next };
  }

  function enter(next: Phase): void {
    phase = next;

    const key = keyOf(next);
    if (key === emittedKey) return;

    emittedKey = key;
    deps.emit(statusOf(next));
  }

  function onUp(): void {
    failures = 0;
    enter(SERVER_STATE_ONLINE);
  }

  function onDown(): void {
    failures += 1;
    enter(
      failures >= WATCH_FAILURES_BEFORE_UNREACHABLE
        ? SERVER_STATE_UNREACHABLE
        : SERVER_STATE_RECONNECTING,
    );
  }

  function onOther(name: string): void {
    // 对方应答说明网络是通的，但原服务器不在这里，按不可达的节奏继续等。
    failures = WATCH_FAILURES_BEFORE_UNREACHABLE;
    otherName = name;
    enter(SERVER_STATE_REPLACED);
  }

  function onMoved(url: string): void {
    // 新地址已经核实过，直接回到在线；moved 是一次性事件，之后的状态键从在线算起。
    failures = 0;
    phase = SERVER_STATE_ONLINE;
    emittedKey = SERVER_STATE_ONLINE;
    deps.emit({ state: SERVER_STATE_MOVED, url });
  }

  function intervalMs(): number {
    if (phase === SERVER_STATE_ONLINE) return WATCH_ONLINE_INTERVAL_MS;
    if (phase === SERVER_STATE_RECONNECTING) return WATCH_RECONNECT_INTERVAL_MS;

    return WATCH_UNREACHABLE_INTERVAL_MS;
  }

  // 按固定间隔排下一次：探测本身的耗时（最长 3 秒的超时）计入间隔。
  function schedule(token: number, startedAt: number): void {
    if (!running || token !== generation) return;

    const delay = Math.max(0, intervalMs() - (now() - startedAt));
    timer = setTimer(() => {
      timer = null;
      run(token);
    }, delay);
  }

  function run(token: number): void {
    void check(token).catch((err: unknown) => {
      console.warn("[server-watch] check failed:", err);
    });
  }

  async function check(token: number): Promise<void> {
    const startedAt = now();

    try {
      const verdict = judge(await probeSelected());
      if (token !== generation) return;

      if (verdict.kind === "up") {
        onUp();
        return;
      }

      const movedTo = await followMoved();
      if (token !== generation) return;

      if (movedTo !== null) onMoved(movedTo);
      else if (verdict.kind === "other") onOther(verdict.name);
      else onDown();
    } finally {
      schedule(token, startedAt);
    }
  }

  function cancelTimer(): void {
    if (timer === null) return;

    clearTimer(timer);
    timer = null;
  }

  return {
    start() {
      if (running) return;

      running = true;
      generation += 1;
      run(generation);
    },

    stop() {
      running = false;
      generation += 1;
      cancelTimer();
    },

    retryNow() {
      if (!running) return;

      generation += 1;
      cancelTimer();

      // 已经判定不可达（或被换机）时，重试先回到重连，界面才看得到“正在重新连接”。
      if (phase === SERVER_STATE_UNREACHABLE || phase === SERVER_STATE_REPLACED) {
        failures = 0;
        enter(SERVER_STATE_RECONNECTING);
      }

      run(generation);
    },
  };
}
