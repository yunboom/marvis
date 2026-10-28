// 输入框的默认地址：mDNS 主机名 + 后端默认端口。
export const DEFAULT_SERVER_ADDRESS = "http://marvis.local:13840";

// 已选服务器的来源：局域网发现 / 手动输入 / 本机单机模式。
export const SERVER_SOURCE_LAN = "lan";
export const SERVER_SOURCE_MANUAL = "manual";
export const SERVER_SOURCE_STANDALONE = "standalone";

export type ServerSource =
  | typeof SERVER_SOURCE_LAN
  | typeof SERVER_SOURCE_MANUAL
  | typeof SERVER_SOURCE_STANDALONE;

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

// 把用户输入规整为 `scheme://host[:port][/path]`：缺少协议时补 http://，
// 保留路径（服务器可能部署在 /marvis 这样的前缀下）但去掉末尾斜杠，
// 丢弃查询串、片段和账号信息。不是合法的 http(s) 地址时返回 null。
// 路径是部署前缀还是页面地址由 probeServer 探测时确定。
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

  return url.origin + url.pathname.replace(/\/+$/, "");
}

// 控制字符（C0、DEL、C1）和会改变文字显示顺序的方向控制符。React 会转义 HTML，但不会去掉这些字符，
// 局域网里的任何设备都能在名称里放进它们来伪装显示内容。
// eslint-disable-next-line no-control-regex
const UNSAFE_DISPLAY_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// 清理局域网广播、/api/config 或 server.json 给出的显示文本：去掉控制字符和方向控制符，再去掉首尾空白。
export function sanitizeDisplayText(value: string): string {
  return value.replace(UNSAFE_DISPLAY_CHARS, "").trim();
}

// mDNS 主机名的后缀。
const MDNS_HOST_SUFFIX = ".local";
// 能放进地址的主机名：小写字母、数字、点和连字符，不以点开头。
const URL_HOSTNAME = /^[a-z0-9-][a-z0-9.-]*$/;

// 把广播的主机名规整为可以放进地址的形式：去掉末尾的点并转小写。含有其他字符时返回 null。
export function mdnsHostname(host: string): string | null {
  const normalized = host.trim().replace(/\.$/, "").toLowerCase();

  return URL_HOSTNAME.test(normalized) ? normalized : null;
}

// 主机名是否是 mDNS 的 .local 名字；这类名字要靠组播解析，耗时可能比普通请求长。
export function isMdnsHostname(hostname: string): boolean {
  const normalized = hostname.replace(/\.$/, "").toLowerCase();

  return normalized.endsWith(MDNS_HOST_SUFFIX) && normalized.length > MDNS_HOST_SUFFIX.length;
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MAX_OCTET = 255;

// 解析 IPv4 字符串，不是合法 IPv4 时返回 null。
function ipv4Octets(address: string): number[] | null {
  const match = IPV4_PATTERN.exec(address.trim());
  if (!match) return null;

  const octets = match.slice(1).map(Number);

  return octets.every((octet) => octet <= MAX_OCTET) ? octets : null;
}

// 是否是私有网段（10/8、172.16/12、192.168/16）的 IPv4。
function isPrivateIPv4([a, b]: number[]): boolean {
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}

// 从通告的地址里挑一个 IPv4：优先私有网段，其次第一个 IPv4；没有 IPv4 时返回 null。
export function preferredIPv4(addresses: string[]): string | null {
  let fallback: string | null = null;

  for (const address of addresses) {
    const octets = ipv4Octets(address);
    if (!octets) continue;

    const normalized = octets.join(".");
    if (isPrivateIPv4(octets)) return normalized;

    fallback ??= normalized;
  }

  return fallback;
}
