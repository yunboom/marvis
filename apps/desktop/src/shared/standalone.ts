// 单机模式：主进程与界面共享的类型、IPC 通道、配置规则与随机密钥。
// 界面文案只说「单机模式」「资源」，这里的服务端、PostgreSQL 等名词只在代码内部使用。

// ---------- 平台 ----------

// 资源包的平台键：<os>-<arch>，与发布流水线的 manifest 一致。
export type StandalonePlatformKey =
  | "darwin-amd64"
  | "darwin-arm64"
  | "linux-amd64"
  | "linux-arm64"
  | "windows-amd64"
  | "windows-arm64";

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

const ARCH_NAMES: Record<string, string> = {
  x64: "amd64",
  arm64: "arm64",
};

// 由 process.platform / process.arch 得出平台键，不支持的组合返回 null。
export function standalonePlatformKey(platform: NodeJS.Platform, arch: string): StandalonePlatformKey | null {
  const os = OS_NAMES[platform];
  const cpu = ARCH_NAMES[arch];
  if (!os || !cpu) return null;

  return `${os}-${cpu}` as StandalonePlatformKey;
}

// ---------- manifest ----------

// 一个可下载的资源包；urls 依次尝试（发布地址在前，镜像在后）。
export interface StandaloneAsset {
  name: string;
  size: number;
  sha256: string;
  urls: string[];
}

// 发布流水线生成的 server-manifest.json。
export interface StandaloneManifest {
  schemaVersion: 1;
  version: string;
  minAppVersion: string;
  server: Partial<Record<StandalonePlatformKey, StandaloneAsset>>;
  postgres: { version: string; assets: Partial<Record<StandalonePlatformKey, StandaloneAsset>> };
}

// 默认的 manifest 地址：最新正式版 Release 上的文件。
export const DEFAULT_STANDALONE_MANIFEST_URL =
  "https://github.com/yunboom/marvis/releases/latest/download/server-manifest.json";

// 覆盖 manifest 地址的环境变量，用于本地联调与镜像。
export const STANDALONE_MANIFEST_URL_ENV = "MARVIS_STANDALONE_MANIFEST_URL";

// ---------- 状态 ----------

export const STANDALONE_PHASE_NOT_INSTALLED = "not_installed";
export const STANDALONE_PHASE_DOWNLOADING = "downloading";
export const STANDALONE_PHASE_PAUSED = "paused";
export const STANDALONE_PHASE_VERIFYING = "verifying";
export const STANDALONE_PHASE_INSTALLING = "installing";
export const STANDALONE_PHASE_STARTING = "starting";
export const STANDALONE_PHASE_RUNNING = "running";
export const STANDALONE_PHASE_STOPPED = "stopped";
export const STANDALONE_PHASE_FAILED = "failed";

export type StandalonePhase =
  | typeof STANDALONE_PHASE_NOT_INSTALLED
  | typeof STANDALONE_PHASE_DOWNLOADING
  | typeof STANDALONE_PHASE_PAUSED
  | typeof STANDALONE_PHASE_VERIFYING
  | typeof STANDALONE_PHASE_INSTALLING
  | typeof STANDALONE_PHASE_STARTING
  | typeof STANDALONE_PHASE_RUNNING
  | typeof STANDALONE_PHASE_STOPPED
  | typeof STANDALONE_PHASE_FAILED;

export const STANDALONE_ERROR_NETWORK = "network";
export const STANDALONE_ERROR_CHECKSUM = "checksum";
export const STANDALONE_ERROR_PORT_IN_USE = "port_in_use";
export const STANDALONE_ERROR_START_FAILED = "start_failed";
export const STANDALONE_ERROR_DISK = "disk";
export const STANDALONE_ERROR_UNSUPPORTED_PLATFORM = "unsupported_platform";
export const STANDALONE_ERROR_MANIFEST = "manifest";

export type StandaloneErrorCode =
  | typeof STANDALONE_ERROR_NETWORK
  | typeof STANDALONE_ERROR_CHECKSUM
  | typeof STANDALONE_ERROR_PORT_IN_USE
  | typeof STANDALONE_ERROR_START_FAILED
  | typeof STANDALONE_ERROR_DISK
  | typeof STANDALONE_ERROR_UNSUPPORTED_PLATFORM
  | typeof STANDALONE_ERROR_MANIFEST;

export interface StandaloneError {
  code: StandaloneErrorCode;
  // 仅用于日志与「查看日志」，界面不直接展示。
  detail?: string;
  // 端口占用时的端口号。
  port?: number;
}

// 下载与安装进度。percent 是合成后的总进度：下载 85%、校验 5%、安装 10%。
export interface StandaloneProgress {
  percent: number;
  receivedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
}

// 资源更新的状态，显示在「设置 › 更新」。
export const STANDALONE_UPDATE_LATEST = "latest";
export const STANDALONE_UPDATE_AVAILABLE = "available";
export const STANDALONE_UPDATE_DOWNLOADING = "downloading";
export const STANDALONE_UPDATE_INSTALLING = "installing";
export const STANDALONE_UPDATE_ROLLED_BACK = "rolled_back";

export type StandaloneUpdateState =
  | typeof STANDALONE_UPDATE_LATEST
  | typeof STANDALONE_UPDATE_AVAILABLE
  | typeof STANDALONE_UPDATE_DOWNLOADING
  | typeof STANDALONE_UPDATE_INSTALLING
  | typeof STANDALONE_UPDATE_ROLLED_BACK;

export interface StandaloneUpdateStatus {
  state: StandaloneUpdateState;
  availableVersion: string | null;
  sizeBytes: number | null;
  progress: StandaloneProgress | null;
  checkedAt: string | null;
}

// 主进程推给界面的单机模式状态。
export interface StandaloneStatus {
  phase: StandalonePhase;
  // 资源已安装的版本，未安装为 null。
  version: string | null;
  progress: StandaloneProgress | null;
  error: StandaloneError | null;
  // 运行中且允许局域网连接时的局域网地址，例如 http://192.168.1.20:13840。
  lanUrl: string | null;
  // 运行中的本机地址，例如 http://127.0.0.1:13840。
  localUrl: string | null;
  startedAt: string | null;
  update: StandaloneUpdateStatus;
}

// ---------- 配置 ----------

// 7 个集成加密密钥的环境变量，规则同服务端 secretbox.LoadKey。
export const INTEGRATION_KEY_ENVS = [
  "MARVIS_LARK_SECRET_KEY",
  "MARVIS_VCS_SECRET_KEY",
  "MARVIS_SLACK_SECRET_KEY",
  "MARVIS_DINGTALK_SECRET_KEY",
  "MARVIS_WECOM_SECRET_KEY",
  "MARVIS_TELEGRAM_SECRET_KEY",
  "MARVIS_PLUGIN_SECRET_KEY",
] as const;

export type IntegrationKeyEnv = (typeof INTEGRATION_KEY_ENVS)[number];

// 用户在「完成设置」里填写的非敏感配置，存 config.json。
export interface StandaloneSettings {
  adminEmail: string;
  name: string;
  port: number;
  lanEnabled: boolean;
  loginCodeEnabled: boolean;
  lark: { appId: string; tenantKeys: string };
  smtp: { host: string; port: number | null; username: string; fromEmail: string };
  llm: { baseUrl: string; model: string };
}

// 敏感配置，经 safeStorage 加密后存 secrets.enc；首次安装成功后 jwtSecret 与 integrationKeys 锁定。
export interface StandaloneSecrets {
  jwtSecret: string;
  integrationKeys: Record<IntegrationKeyEnv, string>;
  loginCode: string;
  postgresPassword: string;
  larkAppSecret: string;
  smtpPassword: string;
  llmApiKey: string;
}

export const DEFAULT_STANDALONE_PORT = 13840;
export const DEFAULT_LOGIN_CODE = "888888";

// 设置页提交的完整表单：非敏感部分 + 敏感部分。
export interface StandaloneSetupInput {
  settings: StandaloneSettings;
  secrets: StandaloneSecrets;
}

// ---------- 校验 ----------

export const VALIDATION_REQUIRED = "required";
export const VALIDATION_EMAIL = "email";
export const VALIDATION_PORT_RANGE = "port_range";
export const VALIDATION_JWT_LENGTH = "jwt_length";
export const VALIDATION_KEY_FORMAT = "key_format";
export const VALIDATION_LOGIN_CODE = "login_code";
export const VALIDATION_LARK_APP_ID = "lark_app_id";
export const VALIDATION_LARK_SECRET_REQUIRED = "lark_secret_required";
export const VALIDATION_TENANT_KEYS = "tenant_keys";
export const VALIDATION_URL = "url";

export type ValidationCode =
  | typeof VALIDATION_REQUIRED
  | typeof VALIDATION_EMAIL
  | typeof VALIDATION_PORT_RANGE
  | typeof VALIDATION_JWT_LENGTH
  | typeof VALIDATION_KEY_FORMAT
  | typeof VALIDATION_LOGIN_CODE
  | typeof VALIDATION_LARK_APP_ID
  | typeof VALIDATION_LARK_SECRET_REQUIRED
  | typeof VALIDATION_TENANT_KEYS
  | typeof VALIDATION_URL;

// 字段路径（如 "settings.port"、"secrets.integrationKeys.MARVIS_VCS_SECRET_KEY"）到错误码。
export type ValidationErrors = Record<string, ValidationCode>;

export const MIN_JWT_SECRET_LENGTH = 32;
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const LOGIN_CODE_PATTERN = /^\d{6}$/;
const LARK_APP_ID_PATTERN = /^cli_[A-Za-z0-9]+$/;
const TENANT_KEYS_PATTERN = /^[A-Za-z0-9_]+(,[A-Za-z0-9_]+)*$/;

// 集成加密密钥：标准 base64，解码后正好 32 字节（与服务端 secretbox.LoadKey 一致）。
export function isIntegrationKey(value: string): boolean {
  if (!KEY_PATTERN.test(value)) return false;
  try {
    return atob(value).length === 32;
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// 校验整份表单，返回空对象表示通过。主进程启动前与界面提交前用同一份规则。
export function validateStandaloneSetup({ settings, secrets }: StandaloneSetupInput): ValidationErrors {
  const errors: ValidationErrors = {};

  if (!settings.adminEmail.trim()) errors["settings.adminEmail"] = VALIDATION_REQUIRED;
  else if (!EMAIL_PATTERN.test(settings.adminEmail.trim())) errors["settings.adminEmail"] = VALIDATION_EMAIL;

  if (!settings.name.trim()) errors["settings.name"] = VALIDATION_REQUIRED;

  if (!Number.isInteger(settings.port) || settings.port < MIN_PORT || settings.port > MAX_PORT) {
    errors["settings.port"] = VALIDATION_PORT_RANGE;
  }

  if (secrets.jwtSecret.length < MIN_JWT_SECRET_LENGTH) errors["secrets.jwtSecret"] = VALIDATION_JWT_LENGTH;
  for (const env of INTEGRATION_KEY_ENVS) {
    if (!isIntegrationKey(secrets.integrationKeys[env] ?? "")) {
      errors[`secrets.integrationKeys.${env}`] = VALIDATION_KEY_FORMAT;
    }
  }

  if (settings.loginCodeEnabled) {
    if (!secrets.loginCode) errors["secrets.loginCode"] = VALIDATION_REQUIRED;
    else if (!LOGIN_CODE_PATTERN.test(secrets.loginCode)) errors["secrets.loginCode"] = VALIDATION_LOGIN_CODE;
  }

  const appId = settings.lark.appId.trim();
  if (appId && !LARK_APP_ID_PATTERN.test(appId)) errors["settings.lark.appId"] = VALIDATION_LARK_APP_ID;
  if (appId && !secrets.larkAppSecret) errors["secrets.larkAppSecret"] = VALIDATION_LARK_SECRET_REQUIRED;
  const tenants = settings.lark.tenantKeys.trim();
  if (tenants && !TENANT_KEYS_PATTERN.test(tenants)) errors["settings.lark.tenantKeys"] = VALIDATION_TENANT_KEYS;

  if (settings.smtp.host.trim()) {
    const port = settings.smtp.port;
    if (port === null || !Number.isInteger(port) || port < 1 || port > MAX_PORT) {
      errors["settings.smtp.port"] = VALIDATION_PORT_RANGE;
    }
  }

  const baseUrl = settings.llm.baseUrl.trim();
  if (baseUrl && !isHttpUrl(baseUrl)) errors["settings.llm.baseUrl"] = VALIDATION_URL;

  return errors;
}

// ---------- 随机密钥 ----------

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

// 32 字节随机数的 64 位十六进制，用于 JWT_SECRET 与一次性 bootstrap token。
export function randomHexSecret(): string {
  return Array.from(randomBytes(32), (b) => b.toString(16).padStart(2, "0")).join("");
}

// 32 字节随机数的标准 base64，用于集成加密密钥。
export function randomIntegrationKey(): string {
  return btoa(String.fromCharCode(...randomBytes(32)));
}

// 6 位随机数字，用于「登录验证码」旁的「随机」按钮。
export function randomLoginCode(): string {
  const [a, b, c] = randomBytes(3);
  return String(((a << 16) | (b << 8) | c) % 1_000_000).padStart(6, "0");
}

// 一份新的敏感配置：密钥全部随机，登录验证码为默认值。
export function generateStandaloneSecrets(): StandaloneSecrets {
  const integrationKeys = {} as Record<IntegrationKeyEnv, string>;
  for (const env of INTEGRATION_KEY_ENVS) integrationKeys[env] = randomIntegrationKey();

  return {
    jwtSecret: randomHexSecret(),
    integrationKeys,
    loginCode: DEFAULT_LOGIN_CODE,
    postgresPassword: randomHexSecret(),
    larkAppSecret: "",
    smtpPassword: "",
    llmApiKey: "",
  };
}

// 一份默认的非敏感配置；name 由调用方传入主机名。
export function defaultStandaloneSettings(hostName: string): StandaloneSettings {
  return {
    adminEmail: "",
    name: hostName,
    port: DEFAULT_STANDALONE_PORT,
    lanEnabled: false,
    loginCodeEnabled: true,
    lark: { appId: "", tenantKeys: "" },
    smtp: { host: "", port: null, username: "", fromEmail: "" },
    llm: { baseUrl: "", model: "" },
  };
}

// ---------- IPC ----------

export const STANDALONE_STATUS = "standalone:status";
export const STANDALONE_STATUS_GET = "standalone:status-get";
export const STANDALONE_DEFAULTS_GET = "standalone:defaults-get";
export const STANDALONE_CONFIG_GET = "standalone:config-get";
export const STANDALONE_INSTALL = "standalone:install";
export const STANDALONE_PAUSE = "standalone:pause";
export const STANDALONE_RESUME = "standalone:resume";
export const STANDALONE_CANCEL = "standalone:cancel";
export const STANDALONE_RETRY = "standalone:retry";
export const STANDALONE_ENTER = "standalone:enter";
export const STANDALONE_RESTART = "standalone:restart";
export const STANDALONE_STOP = "standalone:stop";
export const STANDALONE_SET_LAN = "standalone:set-lan";
export const STANDALONE_SAVE_SETTINGS = "standalone:save-settings";
export const STANDALONE_UPDATE_CHECK = "standalone:update-check";
export const STANDALONE_UPDATE_DOWNLOAD = "standalone:update-download";
export const STANDALONE_UPDATE_INSTALL = "standalone:update-install";
export const STANDALONE_BACKUPS_LIST = "standalone:backups-list";
export const STANDALONE_BACKUP_NOW = "standalone:backup-now";
export const STANDALONE_BACKUP_RESTORE = "standalone:backup-restore";
export const STANDALONE_OPEN_DIR = "standalone:open-dir";
export const STANDALONE_OPEN_LOGS = "standalone:open-logs";
export const STANDALONE_SWITCH_REMOTE = "standalone:switch-remote";

// 「设置」页读取的当前配置：敏感值只告诉界面是否已设置，不回传明文。
export interface StandaloneConfigView {
  settings: StandaloneSettings;
  locked: boolean;
  loginCode: string;
  hasLarkAppSecret: boolean;
  hasSmtpPassword: boolean;
  hasLlmApiKey: boolean;
}

// 备份列表里的一项。
export interface StandaloneBackup {
  fileName: string;
  createdAt: string;
  version: string;
  sizeBytes: number;
  reason: "update" | "manual";
}
