import { chmod, mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import {
  INTEGRATION_KEY_ENVS,
  type IntegrationKeyEnv,
  type StandaloneSecrets,
  type StandaloneSettings,
} from "../../shared/standalone";

// 加解密敏感配置的编解码器；生产环境由 Electron safeStorage 实现，测试里注入可逆的假实现。
export interface SecretCodec {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

// 单机模式的状态文件（非敏感），存 JSON。
export interface StandaloneStateFile {
  settings: StandaloneSettings;
  // 首次启动成功后为 true：jwtSecret 与 integrationKeys 不能再改。
  locked: boolean;
  // 已安装的服务端资源版本（versions/ 下的目录名）。
  serverVersion: string | null;
  // 上一个服务端版本，用于回滚。
  previousServerVersion: string | null;
  postgresVersion: string | null;
  // 首次启动成功的 ISO 时间。
  installedAt: string | null;
}

// SecretStorageUnavailableError 表示系统加密存储不可用，敏感配置无法安全落盘。
export class SecretStorageUnavailableError extends Error {
  constructor() {
    super("secret storage is unavailable");
    this.name = "SecretStorageUnavailableError";
  }
}

const SECRETS_FILE_MODE = 0o600;
const TMP_SUFFIX = ".tmp";

// 读取状态文件。不存在、内容损坏或字段不合法时返回 null，其他读取错误原样抛出。
export async function readStateFile(path: string): Promise<StandaloneStateFile | null> {
  const raw = await readOptionalFile(path);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf-8"));
  } catch {
    return null;
  }

  return toStateFile(parsed);
}

// 写入状态文件：先写临时文件再改名，避免读到写了一半的内容。
export async function writeStateFile(path: string, state: StandaloneStateFile): Promise<void> {
  const body: StandaloneStateFile = {
    settings: state.settings,
    locked: state.locked,
    serverVersion: state.serverVersion,
    previousServerVersion: state.previousServerVersion,
    postgresVersion: state.postgresVersion,
    installedAt: state.installedAt,
  };

  await writeAtomic(path, `${JSON.stringify(body, null, 2)}\n`);
}

// 读取并解密敏感配置。不存在、解密失败或内容不合法时返回 null，其他读取错误原样抛出。
export async function readSecrets(path: string, codec: SecretCodec): Promise<StandaloneSecrets | null> {
  const raw = await readOptionalFile(path);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(codec.decrypt(raw));
  } catch {
    return null;
  }

  return toSecrets(parsed);
}

// 加密后写入敏感配置，文件权限 0600。系统加密存储不可用时抛 SecretStorageUnavailableError，不写明文。
export async function writeSecrets(path: string, secrets: StandaloneSecrets, codec: SecretCodec): Promise<void> {
  if (!codec.isAvailable()) throw new SecretStorageUnavailableError();

  const integrationKeys = {} as Record<IntegrationKeyEnv, string>;
  for (const env of INTEGRATION_KEY_ENVS) integrationKeys[env] = secrets.integrationKeys[env];
  const body: StandaloneSecrets = {
    jwtSecret: secrets.jwtSecret,
    integrationKeys,
    loginCode: secrets.loginCode,
    postgresPassword: secrets.postgresPassword,
    larkAppSecret: secrets.larkAppSecret,
    smtpPassword: secrets.smtpPassword,
    llmApiKey: secrets.llmApiKey,
  };

  await writeAtomic(path, codec.encrypt(JSON.stringify(body)), SECRETS_FILE_MODE);
}

// 合并设置页提交的敏感配置。
// 已锁定时保留现有的 jwtSecret、integrationKeys 与 postgresPassword；
// 设置页拿不到可选密钥的明文，提交 "" 表示不变，除非对应的设置已被清空。
export function mergeSecrets(
  existing: StandaloneSecrets | null,
  incoming: StandaloneSecrets,
  locked: boolean,
  settings: StandaloneSettings,
): StandaloneSecrets {
  const core = locked && existing !== null ? existing : incoming;
  const larkCleared = settings.lark.appId.trim() === "";
  const smtpCleared = settings.smtp.host.trim() === "";
  const llmCleared = settings.llm.baseUrl.trim() === "" && settings.llm.model.trim() === "";

  return {
    jwtSecret: core.jwtSecret,
    integrationKeys: { ...core.integrationKeys },
    loginCode: incoming.loginCode,
    postgresPassword: core.postgresPassword,
    larkAppSecret: mergeOptionalSecret(existing?.larkAppSecret, incoming.larkAppSecret, larkCleared),
    smtpPassword: mergeOptionalSecret(existing?.smtpPassword, incoming.smtpPassword, smtpCleared),
    llmApiKey: mergeOptionalSecret(existing?.llmApiKey, incoming.llmApiKey, llmCleared),
  };
}

function mergeOptionalSecret(existing: string | undefined, incoming: string, cleared: boolean): string {
  if (cleared) return "";
  if (incoming !== "") return incoming;

  return existing ?? "";
}

// ---------- 收窄 ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function toSettings(value: unknown): StandaloneSettings | null {
  if (!isRecord(value)) return null;

  const { adminEmail, name, port, lanEnabled, loginCodeEnabled, lark, smtp, llm } = value;
  if (typeof adminEmail !== "string" || typeof name !== "string") return null;
  if (!isFiniteNumber(port)) return null;
  if (typeof lanEnabled !== "boolean" || typeof loginCodeEnabled !== "boolean") return null;

  if (!isRecord(lark) || typeof lark.appId !== "string" || typeof lark.tenantKeys !== "string") return null;

  if (!isRecord(smtp)) return null;
  if (typeof smtp.host !== "string" || typeof smtp.username !== "string" || typeof smtp.fromEmail !== "string") {
    return null;
  }
  if (smtp.port !== null && !isFiniteNumber(smtp.port)) return null;

  if (!isRecord(llm) || typeof llm.baseUrl !== "string" || typeof llm.model !== "string") return null;

  return {
    adminEmail,
    name,
    port,
    lanEnabled,
    loginCodeEnabled,
    lark: { appId: lark.appId, tenantKeys: lark.tenantKeys },
    smtp: { host: smtp.host, port: smtp.port, username: smtp.username, fromEmail: smtp.fromEmail },
    llm: { baseUrl: llm.baseUrl, model: llm.model },
  };
}

function toStateFile(value: unknown): StandaloneStateFile | null {
  if (!isRecord(value)) return null;

  const settings = toSettings(value.settings);
  if (!settings) return null;

  const { locked, serverVersion, previousServerVersion, postgresVersion, installedAt } = value;
  if (typeof locked !== "boolean") return null;
  if (!isStringOrNull(serverVersion) || !isStringOrNull(previousServerVersion)) return null;
  if (!isStringOrNull(postgresVersion) || !isStringOrNull(installedAt)) return null;

  return { settings, locked, serverVersion, previousServerVersion, postgresVersion, installedAt };
}

function toSecrets(value: unknown): StandaloneSecrets | null {
  if (!isRecord(value)) return null;

  const { jwtSecret, integrationKeys, loginCode, postgresPassword, larkAppSecret, smtpPassword, llmApiKey } = value;
  if (typeof jwtSecret !== "string" || typeof loginCode !== "string") return null;
  if (typeof postgresPassword !== "string") return null;
  if (typeof larkAppSecret !== "string" || typeof smtpPassword !== "string" || typeof llmApiKey !== "string") {
    return null;
  }

  if (!isRecord(integrationKeys)) return null;
  const keys = {} as Record<IntegrationKeyEnv, string>;
  for (const env of INTEGRATION_KEY_ENVS) {
    const key = integrationKeys[env];
    if (typeof key !== "string") return null;
    keys[env] = key;
  }

  return {
    jwtSecret,
    integrationKeys: keys,
    loginCode,
    postgresPassword,
    larkAppSecret,
    smtpPassword,
    llmApiKey,
  };
}

// ---------- 文件 ----------

async function readOptionalFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if (isMissingFileError(err)) return null;
    throw err;
  }
}

// 先写临时文件再改名。指定 mode 时再显式 chmod：临时文件已存在时 writeFile 不会改它的权限。
async function writeAtomic(path: string, data: string | Buffer, mode?: number): Promise<void> {
  const tmp = `${path}${TMP_SUFFIX}`;

  await mkdir(dirname(path), { recursive: true });
  if (mode === undefined) {
    await writeFile(tmp, data);
  } else {
    await writeFile(tmp, data, { mode });
    await chmod(tmp, mode);
  }
  await rename(tmp, path);
}

function isMissingFileError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT",
  );
}
