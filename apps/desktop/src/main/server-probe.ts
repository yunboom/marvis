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

// 请求 `<url>/api/config` 核实对方是不是 Marvis 服务器。
//   - 网络错误或超时（3000 ms，.local 主机名 6000 ms）：unreachable
//   - 非 2xx、响应体超过 1 MiB 或不是 JSON 对象：not_marvis
//   - JSON 里没有 instance_id：too_old
export async function probeServer(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const base = normalizeServerAddress(url);
  if (!base) return { kind: "unreachable" };

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
