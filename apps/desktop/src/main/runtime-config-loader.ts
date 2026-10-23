import { app } from "electron";
import { readFile } from "fs/promises";
import { join } from "path";
import {
  parseRuntimeConfig,
  runtimeConfigFromDevEnv,
  runtimeConfigFromServer,
  type RuntimeConfig,
  type RuntimeConfigEnv,
  type RuntimeConfigResult,
} from "../shared/runtime-config";
import { readSelectedServer, selectedServerPath } from "./server-selection";

// 读取顺序：
//   1. <userData>/server.json：用户选定的服务器；
//   2. ~/.marvis/desktop.json：只读，作为初始值；
//   3. 都没有：未配置，由界面引导用户连接。
// 开发模式设置了 VITE_API_URL 时同样先走连接页，环境变量只作为预填地址，
// 这样首次启动和安装版一致；选中的正是这个开发后端时，沿用环境变量的完整配置
// （探测会丢掉回环的网页地址，开发环境的网页端恰好在 localhost）。
export async function loadRuntimeConfig(options: {
  isDev: boolean;
  env: RuntimeConfigEnv;
  userDataDir: string;
  configPath?: string;
}): Promise<RuntimeConfigResult> {
  let devConfig: RuntimeConfig | null = null;
  if (options.isDev && options.env.apiUrl) {
    try {
      devConfig = runtimeConfigFromDevEnv(options.env);
    } catch (err) {
      return { ok: false, error: { message: errorMessage(err) } };
    }
  }

  try {
    const selected = await readSelectedServer(options.userDataDir);
    if (selected) {
      return { ok: true, config: preferDevConfig(runtimeConfigFromServer(selected), devConfig) };
    }
  } catch (err) {
    return {
      ok: false,
      error: {
        message: `Invalid ${selectedServerPath(options.userDataDir)}: ${errorMessage(err)}`,
      },
    };
  }

  if (devConfig) return { ok: false, unconfigured: true, suggestedAddress: devConfig.apiUrl };

  const configPath = options.configPath ?? desktopConfigPath();
  try {
    const raw = await readFile(configPath, "utf-8");
    return { ok: true, config: parseRuntimeConfig(raw) };
  } catch (err) {
    if (isMissingFileError(err)) {
      return { ok: false, unconfigured: true };
    }
    return {
      ok: false,
      error: {
        message: `Invalid ${configPath}: ${errorMessage(err)}`,
      },
    };
  }
}

// 开发模式选中的正是 VITE_API_URL 指向的后端时，换成环境变量的完整配置。
export function preferDevConfig(
  config: RuntimeConfig,
  devConfig: RuntimeConfig | null,
): RuntimeConfig {
  return devConfig?.apiUrl === config.apiUrl ? devConfig : config;
}

// 开发模式且设置了 VITE_API_URL 时的环境变量配置；不合法时返回 null，
// 启动时由 loadRuntimeConfig 负责报错。
export function devRuntimeConfig(isDev: boolean, env: RuntimeConfigEnv): RuntimeConfig | null {
  if (!isDev || !env.apiUrl) return null;
  try {
    return runtimeConfigFromDevEnv(env);
  } catch {
    return null;
  }
}

export function desktopConfigPath(): string {
  return join(app.getPath("home"), ".marvis", "desktop.json");
}

function isMissingFileError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT",
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type { RuntimeConfig, RuntimeConfigResult };
