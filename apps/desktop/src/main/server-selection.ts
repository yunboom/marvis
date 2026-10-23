import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import {
  normalizeServerAddress,
  sanitizeDisplayText,
  SERVER_SOURCE_LAN,
  SERVER_SOURCE_MANUAL,
  type SelectedServer,
} from "../shared/server-discovery";

const SERVER_FILENAME = "server.json";

export function selectedServerPath(userDataDir: string): string {
  return join(userDataDir, SERVER_FILENAME);
}

// 读取已选服务器。文件不存在、内容损坏或字段不合法时返回 null（按未选择处理），
// 其他读取错误（如权限）原样抛出。
export async function readSelectedServer(userDataDir: string): Promise<SelectedServer | null> {
  let raw: string;
  try {
    raw = await readFile(selectedServerPath(userDataDir), "utf-8");
  } catch (err) {
    if (isMissingFileError(err)) return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return toSelectedServer(parsed);
}

// 写入已选服务器。先写临时文件再改名，避免命令行读到写了一半的内容。
// 键名与命令行共用，固定为 url / name / instanceId / source / appUrl。
export async function writeSelectedServer(
  userDataDir: string,
  selected: SelectedServer,
): Promise<void> {
  const target = selectedServerPath(userDataDir);
  const tmp = `${target}.tmp`;
  const body: SelectedServer = {
    url: selected.url,
    name: selected.name,
    instanceId: selected.instanceId,
    source: selected.source,
    appUrl: selected.appUrl,
  };

  await mkdir(userDataDir, { recursive: true });
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
  await rename(tmp, target);
}

// 把未知输入收窄为 SelectedServer，字段缺失或不合法时返回 null。
// 读盘和校验界面传来的选择共用这一份规则；名称会去掉控制字符和方向控制符，再交给界面显示。
export function toSelectedServer(value: unknown): SelectedServer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const obj = value as Record<string, unknown>;
  const { url, name, instanceId, source, appUrl } = obj;
  if (typeof url !== "string" || normalizeServerAddress(url) === null) return null;
  if (typeof name !== "string") return null;
  if (typeof instanceId !== "string") return null;
  if (source !== SERVER_SOURCE_LAN && source !== SERVER_SOURCE_MANUAL) return null;
  if (typeof appUrl !== "string") return null;

  return { url, name: sanitizeDisplayText(name), instanceId, source, appUrl };
}

function isMissingFileError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT",
  );
}
