import { runtimeConfigFromServer, type RuntimeConfigResult } from "../shared/runtime-config";
import {
  normalizeServerAddress,
  SERVER_CURRENT,
  SERVER_DISCOVER,
  SERVER_DISCOVERED,
  SERVER_PROBE,
  SERVER_RESCAN,
  SERVER_RETRY,
  SERVER_SELECT,
  SERVER_STATE_ONLINE,
  SERVER_STATUS,
  SERVER_STATUS_GET,
  type DiscoveredServer,
  type ProbeResult,
  type SelectedServer,
  type ServerStatus,
} from "../shared/server-discovery";
import type { LanBrowser } from "./lan-browser";
import type { probeServer } from "./server-probe";
import {
  toSelectedServer,
  type readSelectedServer,
  type writeSelectedServer,
} from "./server-selection";

// IPC 里用到的 WebContents 子集，便于用桩测试。
export interface ServerIpcSender {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: "destroyed", listener: () => void): unknown;
}

interface ServerIpcEvent {
  sender: ServerIpcSender;
}

// ipcMain 的子集。
export interface IpcMainLike {
  on(channel: string, listener: (event: ServerIpcEvent, ...args: unknown[]) => void): unknown;
  handle(channel: string, listener: (event: ServerIpcEvent, ...args: unknown[]) => unknown): unknown;
}

export interface ServerControllerDeps {
  userDataDir: string;
  probe: typeof probeServer;
  readSelected: typeof readSelectedServer;
  writeSelected: typeof writeSelectedServer;
  // 更新主进程持有、并同步提供给 preload 的运行配置。
  applyRuntimeConfig: (result: RuntimeConfigResult) => void;
  // 重载所有窗口，让它们按新的运行配置重新启动。
  reloadAll: () => void;
}

// 探测、读取和选定服务器，不依赖 Electron。
export function createServerController(deps: ServerControllerDeps) {
  return {
    async probe(url: unknown): Promise<ProbeResult> {
      if (typeof url !== "string") return { kind: "unreachable" };

      return deps.probe(url);
    },

    current(): Promise<SelectedServer | null> {
      return deps.readSelected(deps.userDataDir);
    },

    // 先落盘，再更新运行配置，最后重载窗口；落盘失败时什么都不改。
    async select(value: unknown): Promise<void> {
      const server = parseSelection(value);
      if (!server) throw new Error("invalid server selection");

      await deps.writeSelected(deps.userDataDir, server);
      deps.applyRuntimeConfig({ ok: true, config: runtimeConfigFromServer(server) });
      deps.reloadAll();
    },
  };
}

// 界面传来的选择不可信：字段必须齐全，地址规整为 origin，网页地址只能是 http(s)。
function parseSelection(value: unknown): SelectedServer | null {
  const parsed = toSelectedServer(value);
  if (!parsed) return null;

  const url = normalizeServerAddress(parsed.url);
  if (!url) return null;
  if (parsed.appUrl !== "" && !isHttpUrl(parsed.appUrl)) return null;

  return { ...parsed, url };
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);

    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// 多个窗口共用一个局域网浏览：第一个订阅者开始，最后一个离开时停止。
function createDiscoveryHub(lanBrowser: LanBrowser) {
  const subscribers = new Map<number, ServerIpcSender>();
  const watched = new WeakSet<ServerIpcSender>();
  let latest: DiscoveredServer[] = [];

  function push(sender: ServerIpcSender): void {
    if (!sender.isDestroyed()) sender.send(SERVER_DISCOVERED, latest);
  }

  function release(): void {
    lanBrowser.stop();
    latest = [];
  }

  function unsubscribe(sender: ServerIpcSender): void {
    if (!subscribers.delete(sender.id)) return;
    if (subscribers.size === 0) release();
  }

  function subscribe(sender: ServerIpcSender): void {
    const isFirst = subscribers.size === 0;
    subscribers.set(sender.id, sender);

    // 窗口销毁时没有机会发来取消订阅，靠 destroyed 事件清理。
    if (!watched.has(sender)) {
      watched.add(sender);
      sender.once("destroyed", () => unsubscribe(sender));
    }

    if (isFirst) {
      lanBrowser.start((list) => {
        latest = list;
        for (const target of subscribers.values()) push(target);
      });
    }
    push(sender);
  }

  // 窗口重载后旧页面里的订阅已经失效，直接全部清掉。
  function clear(): void {
    if (subscribers.size === 0) return;

    subscribers.clear();
    release();
  }

  return { subscribe, unsubscribe, clear };
}

export interface ServerIpcDeps extends ServerControllerDeps {
  ipcMain: IpcMainLike;
  lanBrowser: LanBrowser;
  // 向所有窗口推送一条消息。
  broadcast: (channel: string, payload: unknown) => void;
  // 界面请求立即重试连接，由连接监控接入；默认什么都不做。
  onRetry?: () => void;
  // 当前的连接状态，新打开的窗口据此补上错过的推送；默认在线。
  currentStatus?: () => ServerStatus;
}

// 注册服务器发现、探测和选定相关的 IPC。
// discover 的载荷为 true 表示订阅、false 表示取消订阅。
export function registerServerIpc(deps: ServerIpcDeps) {
  const controller = createServerController(deps);
  const hub = createDiscoveryHub(deps.lanBrowser);

  deps.ipcMain.on(SERVER_DISCOVER, (event, active) => {
    if (typeof active !== "boolean") return;

    if (active) hub.subscribe(event.sender);
    else hub.unsubscribe(event.sender);
  });

  deps.ipcMain.on(SERVER_RESCAN, () => {
    deps.lanBrowser.rescan();
  });

  deps.ipcMain.on(SERVER_RETRY, () => {
    deps.onRetry?.();
  });

  deps.ipcMain.handle(
    SERVER_STATUS_GET,
    (): ServerStatus => deps.currentStatus?.() ?? { state: SERVER_STATE_ONLINE },
  );

  deps.ipcMain.handle(SERVER_PROBE, (_event, url) => controller.probe(url));

  deps.ipcMain.handle(SERVER_CURRENT, () => controller.current());

  deps.ipcMain.handle(SERVER_SELECT, async (_event, value) => {
    await controller.select(value);
    hub.clear();
  });

  return {
    // 把连接状态推送给所有窗口。
    publishStatus(status: ServerStatus): void {
      deps.broadcast(SERVER_STATUS, status);
    },
  };
}
