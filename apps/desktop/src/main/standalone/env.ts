import { INTEGRATION_KEY_ENVS, type StandaloneSecrets, type StandaloneSettings } from "../../shared/standalone";

// 启动本机服务端所需的输入。
export interface ServerEnvInput {
  settings: StandaloneSettings;
  secrets: StandaloneSecrets;
  databaseUrl: string;
  uploadsDir: string;
  bootstrapToken: string;
  // 桌面端自身的环境变量；只复制白名单，开发者 shell 里的 MARVIS_* / DATABASE_URL 不会带进去。
  baseEnv: NodeJS.ProcessEnv;
}

// 从桌面端环境复制给子进程的变量白名单。
const INHERITED_ENV_KEYS = ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"];

const APP_ENV_PRODUCTION = "production";
const FLAG_ON = "1";
const BOOL_TRUE = "true";
const BOOL_FALSE = "false";
const LOOPBACK_HOST = "127.0.0.1";
// 监听所有网卡：服务端把空字符串当作不限制监听地址。
const LISTEN_ALL_HOSTS = "";
const LARK_DESKTOP_CALLBACK_PATH = "/auth/lark/desktop-callback";

// 组装本机服务端的完整环境变量。不设置 REDIS_URL：单机模式不依赖 Redis。
export function buildServerEnv(input: ServerEnvInput): NodeJS.ProcessEnv {
  const { settings, secrets } = input;
  const env = inheritEnv(input.baseEnv);

  env.APP_ENV = APP_ENV_PRODUCTION;
  env.MARVIS_STANDALONE = FLAG_ON;
  env.ALLOW_SIGNUP = BOOL_TRUE;
  env.DO_NOT_TRACK = FLAG_ON;
  env.MARVIS_APP_URL = "";
  env.DATABASE_URL = input.databaseUrl;
  env.LOCAL_UPLOAD_DIR = input.uploadsDir;

  env.PORT = String(settings.port);
  env.MARVIS_LISTEN_HOST = settings.lanEnabled ? LISTEN_ALL_HOSTS : LOOPBACK_HOST;
  env.MARVIS_LAN_DISCOVERY = settings.lanEnabled ? BOOL_TRUE : BOOL_FALSE;
  env.MARVIS_LAN_NAME = settings.name.trim();

  env.JWT_SECRET = secrets.jwtSecret;
  for (const key of INTEGRATION_KEY_ENVS) env[key] = secrets.integrationKeys[key];
  env.MARVIS_BOOTSTRAP_TOKEN = input.bootstrapToken;

  if (settings.loginCodeEnabled) env.MARVIS_DEV_VERIFICATION_CODE = secrets.loginCode;

  const larkAppId = settings.lark.appId.trim();
  if (larkAppId) {
    env.MARVIS_LARK_LOGIN_APP_ID = larkAppId;
    env.MARVIS_LARK_LOGIN_APP_SECRET = secrets.larkAppSecret;
    setIfPresent(env, "MARVIS_LARK_LOGIN_TENANT_KEYS", settings.lark.tenantKeys);
    // 开启局域网时由服务端按 mDNS 主机名推导回调地址。
    if (!settings.lanEnabled) {
      env.MARVIS_LARK_LOGIN_DESKTOP_REDIRECT_URI = `http://localhost:${settings.port}${LARK_DESKTOP_CALLBACK_PATH}`;
    }
  }

  const smtpHost = settings.smtp.host.trim();
  if (smtpHost) {
    env.SMTP_HOST = smtpHost;
    if (settings.smtp.port !== null) env.SMTP_PORT = String(settings.smtp.port);
    setIfPresent(env, "SMTP_USERNAME", settings.smtp.username);
    setSecretIfPresent(env, "SMTP_PASSWORD", secrets.smtpPassword);
    setIfPresent(env, "SMTP_FROM_EMAIL", settings.smtp.fromEmail);
  }

  setIfPresent(env, "MARVIS_LLM_BASE_URL", settings.llm.baseUrl);
  setIfPresent(env, "MARVIS_LLM_DEFAULT_MODEL", settings.llm.model);
  setSecretIfPresent(env, "MARVIS_LLM_API_KEY", secrets.llmApiKey);

  return env;
}

// 组装数据库迁移命令的环境变量：白名单 + DATABASE_URL。
export function buildMigrateEnv(databaseUrl: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = inheritEnv(baseEnv);
  env.DATABASE_URL = databaseUrl;

  return env;
}

function inheritEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }

  return env;
}

// 值去掉首尾空白后非空才写入。
function setIfPresent(env: NodeJS.ProcessEnv, key: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed) env[key] = trimmed;
}

// 密钥原样写入（不去空白，避免改动密钥本身），为空则不写。
function setSecretIfPresent(env: NodeJS.ProcessEnv, key: string, value: string): void {
  if (value) env[key] = value;
}
