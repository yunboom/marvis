import type { SelectedServer } from "../../shared/server-discovery";
import {
  INTEGRATION_KEY_ENVS,
  STANDALONE_BACKUP_NOW,
  STANDALONE_BACKUP_RESTORE,
  STANDALONE_BACKUPS_LIST,
  STANDALONE_CANCEL,
  STANDALONE_CONFIG_GET,
  STANDALONE_DEFAULTS_GET,
  STANDALONE_ENTER,
  STANDALONE_INSTALL,
  STANDALONE_OPEN_DIR,
  STANDALONE_OPEN_LOGS,
  STANDALONE_PAUSE,
  STANDALONE_RESTART,
  STANDALONE_RESUME,
  STANDALONE_RETRY,
  STANDALONE_SAVE_SETTINGS,
  STANDALONE_SET_LAN,
  STANDALONE_STATUS,
  STANDALONE_STATUS_GET,
  STANDALONE_STOP,
  STANDALONE_SWITCH_REMOTE,
  STANDALONE_UPDATE_CHECK,
  STANDALONE_UPDATE_DOWNLOAD,
  STANDALONE_UPDATE_INSTALL,
  STANDALONE_AUTO_UPDATE_GET,
  STANDALONE_AUTO_UPDATE_SET,
  type StandaloneSecrets,
  type StandaloneSettings,
  type StandaloneSetupInput,
  type StandaloneStatus,
  type StandaloneSubmitResult,
} from "../../shared/standalone";
import type { IpcMainLike } from "../server-ipc";
import { toSelectedServer } from "../server-selection";
import { StandaloneValidationError, type StandaloneManager } from "./manager";

export interface StandaloneIpcDeps {
  ipcMain: IpcMainLike;
  manager: StandaloneManager;
  broadcast: (channel: string, payload: unknown) => void;
  // 在系统文件管理器里打开目录。
  openPath: (path: string) => Promise<unknown>;
  // 写入远程服务器选择、更新运行配置并重载窗口。
  selectRemote: (server: SelectedServer) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function toSettings(value: unknown): StandaloneSettings | null {
  if (!isRecord(value)) return null;
  const { adminEmail, name, port, lanEnabled, loginCodeEnabled, lark, smtp, llm } = value;
  if (!isString(adminEmail) || !isString(name) || typeof port !== "number") return null;
  if (typeof lanEnabled !== "boolean" || typeof loginCodeEnabled !== "boolean") return null;
  if (!isRecord(lark) || !isString(lark.appId) || !isString(lark.tenantKeys)) return null;
  if (!isRecord(smtp) || !isString(smtp.host) || !isString(smtp.username) || !isString(smtp.fromEmail)) return null;
  if (smtp.port !== null && typeof smtp.port !== "number") return null;
  if (!isRecord(llm) || !isString(llm.baseUrl) || !isString(llm.model)) return null;

  return {
    adminEmail,
    name,
    port,
    lanEnabled,
    loginCodeEnabled,
    lark: { appId: lark.appId, tenantKeys: lark.tenantKeys },
    smtp: { host: smtp.host, port: smtp.port as number | null, username: smtp.username, fromEmail: smtp.fromEmail },
    llm: { baseUrl: llm.baseUrl, model: llm.model },
  };
}

function toSecrets(value: unknown): StandaloneSecrets | null {
  if (!isRecord(value) || !isRecord(value.integrationKeys)) return null;
  const { jwtSecret, loginCode, postgresPassword, larkAppSecret, smtpPassword, llmApiKey } = value;
  const fields = [jwtSecret, loginCode, postgresPassword, larkAppSecret, smtpPassword, llmApiKey];
  if (!fields.every(isString)) return null;
  const keys = value.integrationKeys;
  const integrationKeys = {} as StandaloneSecrets["integrationKeys"];
  for (const env of INTEGRATION_KEY_ENVS) {
    const key = keys[env];
    if (!isString(key)) return null;
    integrationKeys[env] = key;
  }

  return {
    jwtSecret: jwtSecret as string,
    integrationKeys,
    loginCode: loginCode as string,
    postgresPassword: postgresPassword as string,
    larkAppSecret: larkAppSecret as string,
    smtpPassword: smtpPassword as string,
    llmApiKey: llmApiKey as string,
  };
}

// 界面传来的表单先收窄形状，再交给共享的校验规则。
export function toSetupInput(value: unknown): StandaloneSetupInput | null {
  if (!isRecord(value)) return null;
  const settings = toSettings(value.settings);
  const secrets = toSecrets(value.secrets);
  return settings && secrets ? { settings, secrets } : null;
}

async function submit(action: () => Promise<void>): Promise<StandaloneSubmitResult> {
  try {
    await action();
    return { ok: true };
  } catch (err) {
    if (err instanceof StandaloneValidationError) return { ok: false, errors: err.errors };
    throw err;
  }
}

function requireSetupInput(value: unknown): StandaloneSetupInput {
  const input = toSetupInput(value);
  if (!input) throw new Error("invalid standalone setup payload");
  return input;
}

// 注册单机模式的 IPC；返回推送状态的函数，交给 manager 的 publish。
export function registerStandaloneIpc(deps: StandaloneIpcDeps): void {
  const { ipcMain, manager } = deps;

  ipcMain.handle(STANDALONE_STATUS_GET, (): StandaloneStatus => manager.status());
  ipcMain.handle(STANDALONE_DEFAULTS_GET, () => manager.defaults());
  ipcMain.handle(STANDALONE_CONFIG_GET, () => manager.configView());

  ipcMain.handle(STANDALONE_INSTALL, (_event, value) => submit(() => manager.install(requireSetupInput(value))));
  ipcMain.handle(STANDALONE_SAVE_SETTINGS, (_event, value) =>
    submit(() => manager.saveSettings(requireSetupInput(value))),
  );

  ipcMain.on(STANDALONE_PAUSE, () => manager.pause());
  ipcMain.on(STANDALONE_RESUME, () => manager.resume());
  ipcMain.handle(STANDALONE_CANCEL, () => manager.cancel());
  ipcMain.handle(STANDALONE_RETRY, () => manager.retry());

  ipcMain.handle(STANDALONE_ENTER, () => manager.enter());
  ipcMain.handle(STANDALONE_RESTART, () => manager.restart());
  ipcMain.handle(STANDALONE_STOP, () => manager.stop());
  ipcMain.handle(STANDALONE_SET_LAN, (_event, enabled) => {
    if (typeof enabled !== "boolean") throw new Error("invalid LAN flag");
    return manager.setLan(enabled);
  });
  ipcMain.handle(STANDALONE_AUTO_UPDATE_GET, () => manager.autoDownloadUpdates());
  ipcMain.handle(STANDALONE_AUTO_UPDATE_SET, (_event, enabled) => {
    if (typeof enabled !== "boolean") throw new Error("invalid auto update flag");
    return manager.setAutoDownloadUpdates(enabled);
  });

  ipcMain.handle(STANDALONE_UPDATE_CHECK, () => manager.checkForUpdate());
  ipcMain.handle(STANDALONE_UPDATE_DOWNLOAD, () => manager.downloadUpdate());
  ipcMain.handle(STANDALONE_UPDATE_INSTALL, () => manager.installUpdate());

  ipcMain.handle(STANDALONE_BACKUPS_LIST, () => manager.listBackups());
  ipcMain.handle(STANDALONE_BACKUP_NOW, () => manager.backupNow());
  ipcMain.handle(STANDALONE_BACKUP_RESTORE, (_event, fileName) => {
    if (typeof fileName !== "string") throw new Error("invalid backup name");
    return manager.restoreBackup(fileName);
  });

  ipcMain.handle(STANDALONE_OPEN_DIR, () => deps.openPath(manager.dataRoot()));
  ipcMain.handle(STANDALONE_OPEN_LOGS, () => deps.openPath(manager.logsDir()));

  // 已探测通过的远程服务器：先切换过去，再停掉单机模式（本机数据保留）。
  ipcMain.handle(STANDALONE_SWITCH_REMOTE, async (_event, value) => {
    const server = toSelectedServer(value);
    if (!server) throw new Error("invalid server selection");
    await deps.selectRemote(server);
    await manager.stopForRemote();
  });
}

// manager 的 publish：把状态推给所有窗口。
export function standaloneStatusPublisher(broadcast: StandaloneIpcDeps["broadcast"]) {
  return (status: StandaloneStatus) => broadcast(STANDALONE_STATUS, status);
}
