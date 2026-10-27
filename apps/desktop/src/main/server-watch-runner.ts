import { runtimeConfigFromServer, type RuntimeConfigResult } from "../shared/runtime-config";
import {
  normalizeServerAddress,
  SERVER_SOURCE_MANUAL,
  SERVER_STATE_MOVED,
  SERVER_STATE_ONLINE,
  type DiscoveredServer,
  type SelectedServer,
  type ServerStatus,
} from "../shared/server-discovery";
import type { LanBrowser } from "./lan-browser";
import type { probeServer } from "./server-probe";
import type { readSelectedServer, writeSelectedServer } from "./server-selection";
import { createServerWatch, type ServerWatch } from "./server-watch";

// 跟随到新地址后，等多久再重载窗口：让界面先收下 moved 通知并记住它，
// 窗口重载后再弹出提示。
export const MOVED_RELOAD_DELAY_MS = 500;

export interface ServerWatchRunnerDeps {
  userDataDir: string;
  // 主进程当前持有的运行配置，也就是窗口实际在用的服务器。
  getRuntimeConfig: () => RuntimeConfigResult;
  readSelected: typeof readSelectedServer;
  writeSelected: typeof writeSelectedServer;
  // 更新主进程持有、并同步提供给 preload 的运行配置。
  applyRuntimeConfig: (result: RuntimeConfigResult) => void;
  probe: typeof probeServer;
  // 监测专用的局域网浏览器，不能与界面订阅共用同一个实例。
  lanBrowser: LanBrowser;
  // 向所有窗口推送一条连接状态。
  publish: (status: ServerStatus) => void;
  // 重载所有窗口，让它们按新的运行配置重新启动。
  reloadAll: () => void;
}

export interface ServerWatchRunner {
  // 按当前的运行配置和已保存的选择（重新）启动监测。选定新服务器后调用。
  restart(): Promise<void>;
  retryNow(): void;
  stop(): void;
  // 最近一次的连接状态，新打开的窗口据此补上错过的状态。
  currentStatus(): ServerStatus;
}

// 决定监测哪台服务器：
//   - 已保存的选择就是窗口在用的服务器：监测它，带身份，可做搬迁和换机检测；
//   - 没有保存（手写预设）或窗口用的是别的地址（开发环境变量）：只监测窗口实际用的地址；
//   - 运行配置不可用（还没连接过服务器）：不监测。
export function resolveWatchTarget(
  runtime: RuntimeConfigResult,
  saved: SelectedServer | null,
): SelectedServer | null {
  if (!runtime.ok) return null;

  const { apiUrl, appUrl } = runtime.config;
  if (saved && sameAddress(saved.url, apiUrl)) return saved;

  return {
    url: apiUrl,
    name: hostOf(apiUrl),
    instanceId: "",
    source: SERVER_SOURCE_MANUAL,
    appUrl,
  };
}

function sameAddress(a: string, b: string): boolean {
  return (normalizeServerAddress(a) ?? a) === (normalizeServerAddress(b) ?? b);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// 把监测接到主进程：选目标、掉线期间才浏览局域网、跟随搬迁后落盘并重载窗口。
export function createServerWatchRunner(deps: ServerWatchRunnerDeps): ServerWatchRunner {
  let watch: ServerWatch | null = null;
  let current: ServerStatus = { state: SERVER_STATE_ONLINE };
  let lanActive = false;
  let discovered: DiscoveredServer[] = [];
  // 每次 restart 加一，用来丢弃读盘期间被更新的 restart 取代的那一次。
  let restartToken = 0;

  function startLan(): void {
    if (lanActive) return;

    lanActive = true;
    deps.lanBrowser.start((list) => {
      discovered = list;
    });
  }

  function stopLan(): void {
    if (!lanActive) return;

    lanActive = false;
    discovered = [];
    deps.lanBrowser.stop();
  }

  function stopWatch(): void {
    watch?.stop();
    watch = null;
    stopLan();
    current = { state: SERVER_STATE_ONLINE };
  }

  // 只有不在线、且知道实例身份时才需要浏览局域网找新地址。
  function handleStatus(status: ServerStatus, tracksIdentity: boolean): void {
    const settled = status.state === SERVER_STATE_ONLINE || status.state === SERVER_STATE_MOVED;
    if (settled) stopLan();
    else if (tracksIdentity) startLan();

    // moved 是一次性通知，之后新窗口看到的就是在线。
    current = status.state === SERVER_STATE_MOVED ? { state: SERVER_STATE_ONLINE } : status;
    deps.publish(status);

    if (status.state === SERVER_STATE_MOVED) {
      setTimeout(() => deps.reloadAll(), MOVED_RELOAD_DELAY_MS);
    }
  }

  async function saveMoved(next: SelectedServer): Promise<void> {
    // 先落盘，再更新窗口重载时读取的运行配置。
    await deps.writeSelected(deps.userDataDir, next);
    deps.applyRuntimeConfig({ ok: true, config: runtimeConfigFromServer(next) });
  }

  async function readSaved(): Promise<SelectedServer | null> {
    try {
      return await deps.readSelected(deps.userDataDir);
    } catch (err) {
      // 读不到已保存的选择时退回到运行配置里的地址，不让监测整体失效。
      console.warn("[server-watch] failed to read the saved server:", err);

      return null;
    }
  }

  return {
    async restart() {
      restartToken += 1;
      const token = restartToken;
      stopWatch();

      const saved = await readSaved();
      if (token !== restartToken) return;

      const target = resolveWatchTarget(deps.getRuntimeConfig(), saved);
      if (!target) return;

      const tracksIdentity = target.instanceId !== "";
      watch = createServerWatch({
        selected: target,
        probe: deps.probe,
        discovered: () => discovered,
        save: saveMoved,
        emit: (status) => handleStatus(status, tracksIdentity),
      });
      watch.start();
    },

    retryNow() {
      watch?.retryNow();
    },

    stop() {
      restartToken += 1;
      stopWatch();
    },

    currentStatus() {
      return current;
    },
  };
}
