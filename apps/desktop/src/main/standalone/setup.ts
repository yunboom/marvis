import { hostname } from "node:os";

import { app, ipcMain, safeStorage, shell } from "electron";

import {
  SERVER_SOURCE_STANDALONE,
  preferredIPv4,
  type SelectedServer,
} from "../../shared/server-discovery";
import {
  DEFAULT_STANDALONE_MANIFEST_URL,
  STANDALONE_MANIFEST_URL_ENV,
  standalonePlatformKey,
} from "../../shared/standalone";
import { listLocalAddresses } from "../lan-browser";
import { probeServer } from "../server-probe";
import { readSelectedServer } from "../server-selection";
import type { SecretCodec } from "./config-store";
import { registerStandaloneIpc, standaloneStatusPublisher } from "./ipc";
import { StandaloneManager } from "./manager";
import { standaloneLayout, standaloneRoot } from "./paths";

// 资源更新的检查间隔。
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOCAL_SUFFIX = /\.local\.?$/i;

// 用系统钥匙串（safeStorage）加解密单机模式的敏感配置。
const safeStorageCodec: SecretCodec = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (data) => safeStorage.decryptString(data),
};

export interface StandaloneSetupDeps {
  isDev: boolean;
  userDataDir: string;
  broadcast: (channel: string, payload: unknown) => void;
  // 选定服务器（与设置页同一套流程：落盘 → 更新运行配置 → 重载窗口）。
  selectServer: (server: SelectedServer) => Promise<void>;
  // 把登录凭证交给主窗口（auth:token 队列）。
  deliverToken: (token: string) => void;
}

function log(message: string, extra?: Record<string, unknown>): void {
  console.log(`[standalone] ${message}`, extra ?? "");
}

// 创建单机模式管理器、注册 IPC、按上次的选择自动启动，并在退出前停掉本地服务。
export async function setupStandalone(deps: StandaloneSetupDeps): Promise<StandaloneManager> {
  const layout = standaloneLayout(
    standaloneRoot(app.getPath("appData"), { isDev: deps.isDev, appName: app.getName() }),
  );

  const manager = new StandaloneManager({
    layout,
    platformKey: standalonePlatformKey(process.platform, process.arch),
    appVersion: app.getVersion(),
    manifestUrl: process.env[STANDALONE_MANIFEST_URL_ENV] || DEFAULT_STANDALONE_MANIFEST_URL,
    hostName: hostname().replace(LOCAL_SUFFIX, ""),
    baseEnv: process.env,
    codec: safeStorageCodec,
    publish: standaloneStatusPublisher(deps.broadcast),
    lanAddress: () => preferredIPv4(listLocalAddresses()),
    selectStandaloneServer: async (localUrl, name) => {
      const probe = await probeServer(localUrl);
      if (probe.kind !== "ok") throw new Error(`standalone server is not reachable at ${localUrl}`);
      await deps.selectServer({
        url: localUrl,
        name,
        instanceId: probe.server.instanceId,
        source: SERVER_SOURCE_STANDALONE,
        appUrl: "",
      });
    },
    deliverToken: deps.deliverToken,
    log,
  });
  await manager.init();

  registerStandaloneIpc({
    ipcMain,
    manager,
    broadcast: deps.broadcast,
    openPath: (path) => shell.openPath(path),
    selectRemote: deps.selectServer,
  });

  // 上次选的是单机模式：随 App 启动拉起本地服务；界面在服务就绪前显示「正在启动」。
  const selected = await readSelectedServer(deps.userDataDir).catch(() => null);
  if (selected?.source === SERVER_SOURCE_STANDALONE && manager.isInstalled()) {
    void manager
      .start()
      .then(() => manager.checkForUpdate())
      .catch((err) => log("auto start failed", { error: String(err) }));
  }

  const timer = setInterval(() => {
    if (manager.isRunning()) void manager.checkForUpdate();
  }, UPDATE_CHECK_INTERVAL_MS);
  timer.unref();

  // 服务端随 App 退出：先同步阻止退出，停完服务端和数据库再真正退出。
  let stopped = false;
  app.on("before-quit", (event) => {
    if (stopped || !manager.isRunning()) return;
    event.preventDefault();
    void manager
      .stop()
      .catch((err) => log("stop on quit failed", { error: String(err) }))
      .finally(() => {
        stopped = true;
        app.quit();
      });
  });

  return manager;
}
