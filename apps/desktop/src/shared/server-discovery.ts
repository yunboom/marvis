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

// 局域网发现到的服务器：身份取自 /api/config 的核实结果。
// isLocal 表示服务器就在本机；compatible 为 false 表示版本过旧，不能选用。
export interface DiscoveredServer extends ServerIdentity {
  isLocal: boolean;
  compatible: boolean;
}

// 已选服务器的连接状态，由主进程推送给界面。
export const SERVER_STATE_ONLINE = "online";
export const SERVER_STATE_RECONNECTING = "reconnecting";
export const SERVER_STATE_UNREACHABLE = "unreachable";
export const SERVER_STATE_MOVED = "moved";
export const SERVER_STATE_REPLACED = "replaced";

export type ServerStatus =
  | { state: typeof SERVER_STATE_ONLINE }
  | { state: typeof SERVER_STATE_RECONNECTING }
  | { state: typeof SERVER_STATE_UNREACHABLE }
  | { state: typeof SERVER_STATE_MOVED; url: string }
  | { state: typeof SERVER_STATE_REPLACED; otherName: string };

// 服务器发现相关的 IPC 通道。
export const SERVER_DISCOVER = "server:discover";
export const SERVER_DISCOVERED = "server:discovered";
export const SERVER_RESCAN = "server:rescan";
export const SERVER_PROBE = "server:probe";
export const SERVER_CURRENT = "server:current";
export const SERVER_SELECT = "server:select";
export const SERVER_STATUS = "server:status";
export const SERVER_STATUS_GET = "server:status-get";
export const SERVER_RETRY = "server:retry";

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
