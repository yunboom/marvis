import {
  isMdnsHostname,
  normalizeServerAddress,
  sanitizeDisplayText,
  type ProbeResult,
  type ServerIdentity,
} from "../shared/server-discovery";

const CONFIG_PATH = "/api/config";
const PROBE_TIMEOUT_MS = 3000;
// .local 地址要靠组播解析，可能比普通请求多花几秒，超时放宽。
export const MDNS_PROBE_TIMEOUT_MS = 6000;
// /api/config 响应体的读取上限，与命令行一致；Marvis 的响应远小于这个值。
const MAX_CONFIG_BODY_BYTES = 1024 * 1024;

// 网页地址不能指向回环主机：服务器自己配的 localhost 对其他电脑没有意义。
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// 核实地址对应的是不是 Marvis 服务器，成功时 server.url 是确认过的服务器地址。
//
// 地址里的路径可能是部署前缀（https://host/marvis），也可能是粘贴进来的页面地址
// （https://host/marvis/acme/issues/1、http://host:3000/login）。从完整路径开始，
// 每次去掉末尾一段再试，取第一个确认是 Marvis 的地址；只有 not_marvis 才继续往上试，
// 主机不可达或版本过旧时换路径也没用，直接返回。
export async function probeServer(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const address = normalizeServerAddress(url);
  if (!address) return { kind: "unreachable" };

  let result: ProbeResult = { kind: "not_marvis" };
  for (const base of baseCandidates(address)) {
    result = await probeBase(base, fetchImpl);
    if (result.kind !== "not_marvis") return result;
  }

  return result;
}

// https://host/a/b → https://host/a/b、https://host/a、https://host
function baseCandidates(address: string): string[] {
  const url = new URL(address);
  const segments = url.pathname.split("/").filter(Boolean);
  const candidates: string[] = [];
  for (let n = segments.length; n >= 0; n--) {
    const path = segments.slice(0, n).join("/");
    candidates.push(path ? `${url.origin}/${path}` : url.origin);
  }

  return candidates;
}

// 请求 `<base>/api/config` 核实对方是不是 Marvis 服务器。
//   - 网络错误或超时（3000 ms，.local 主机名 6000 ms）：unreachable
//   - 非 2xx、响应体超过 1 MiB 或不是 JSON 对象：not_marvis
//   - JSON 里没有 instance_id：too_old
async function probeBase(base: string, fetchImpl: typeof fetch): Promise<ProbeResult> {
  const timeoutMs = isMdnsHostname(new URL(base).hostname) ? MDNS_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(`${base}${CONFIG_PATH}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { kind: "not_marvis" };

    const text = await readLimitedText(res, MAX_CONFIG_BODY_BYTES);
    if (text === null) return { kind: "not_marvis" };

    const body = parseJsonObject(text);
    if (!body) return { kind: "not_marvis" };

    return identityFromConfig(base, body);
  } catch {
    // 读取响应体途中超时也会走到这里，统一视为不可达。
    return { kind: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

// 读取响应体，超过 limit 字节时停止读取并返回 null。
async function readLimitedText(res: Response, limit: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel();
    return null;
  }

  if (!res.body) return "";

  // 逐块读取同一个响应流，读到上限就停，不等整个响应体到齐。
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf-8");
}

function identityFromConfig(base: string, body: Record<string, unknown>): ProbeResult {
  const instanceId = sanitizeDisplayText(stringField(body.instance_id));
  if (instanceId === "") return { kind: "too_old" };

  const host = new URL(base).hostname;
  const server: ServerIdentity = {
    url: base,
    name: sanitizeDisplayText(stringField(body.server_name)) || host,
    version: sanitizeDisplayText(stringField(body.server_version)),
    instanceId,
    host,
    appUrl: appUrlFromConfig(body.daemon_app_url),
  };

  return { kind: "ok", server };
}

// 只在 daemon_app_url 是非回环的 http(s) 地址时采用，否则返回空串（没有网页端）。
function appUrlFromConfig(value: unknown): string {
  const raw = stringField(value);
  if (raw === "") return "";

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  if (LOOPBACK_HOSTS.has(url.hostname)) return "";

  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/+$/, "");
}

// 响应体不是 JSON 对象（HTML、数组、null 等）时返回 null。
function parseJsonObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  return parsed as Record<string, unknown>;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
