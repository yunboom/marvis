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
//   1. 开发模式且设置了 VITE_API_URL：用环境变量；
//   2. <userData>/server.json：用户选定的服务器；
//   3. ~/.marvis/desktop.json：只读，作为初始值；
//   4. 都没有：未配置，由界面引导用户连接。
export async function loadRuntimeConfig(options: {
  isDev: boolean;
  env: RuntimeConfigEnv;
  userDataDir: string;
  configPath?: string;
}): Promise<RuntimeConfigResult> {
  if (options.isDev && options.env.apiUrl) {
    try {
      return { ok: true, config: runtimeConfigFromDevEnv(options.env) };
    } catch (err) {
      return { ok: false, error: { message: errorMessage(err) } };
    }
  }

  try {
    const selected = await readSelectedServer(options.userDataDir);
    if (selected) return { ok: true, config: runtimeConfigFromServer(selected) };
  } catch (err) {
    return {
      ok: false,
      error: {
        message: `Invalid ${selectedServerPath(options.userDataDir)}: ${errorMessage(err)}`,
      },
    };
  }

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
