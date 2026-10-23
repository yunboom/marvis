// 输入框的默认地址：mDNS 主机名 + 后端默认端口。
export const DEFAULT_SERVER_ADDRESS = "http://marvis.local:13840";

// 已选服务器的来源：局域网发现 / 手动输入。
export const SERVER_SOURCE_LAN = "lan";
export const SERVER_SOURCE_MANUAL = "manual";

export type ServerSource = typeof SERVER_SOURCE_LAN | typeof SERVER_SOURCE_MANUAL;

// 经 /api/config 核实后的服务器身份。appUrl 为空串表示没有网页端。
export interface ServerIdentity {
  url: string;
  name: string;
  version: string;
  instanceId: string;
  host: string;
  appUrl: string;
}

export type ProbeResult =
  | { kind: "ok"; server: ServerIdentity }
  | { kind: "unreachable" }
  | { kind: "not_marvis" }
  | { kind: "too_old" };

// 用户确认后落盘到 <userData>/server.json 的选择。命令行读取同一份文件，
// 键名（url / name / instanceId / source / appUrl）不能随意改动。
export interface SelectedServer {
  url: string;
  name: string;
  instanceId: string;
  source: ServerSource;
  appUrl: string;
}

const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;

// 把用户输入规整为 `scheme://host[:port]`：缺少协议时补 http://，
// 丢弃路径、查询串、片段和账号信息。不是合法的 http(s) 地址时返回 null。
export function normalizeServerAddress(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  const candidate = SCHEME_PREFIX.test(trimmed) ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === "") return null;

  return url.origin;
}
