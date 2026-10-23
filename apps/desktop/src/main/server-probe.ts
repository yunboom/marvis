import {
  normalizeServerAddress,
  type ProbeResult,
  type ServerIdentity,
} from "../shared/server-discovery";

const CONFIG_PATH = "/api/config";
const PROBE_TIMEOUT_MS = 3000;

// 网页地址不能指向回环主机：服务器自己配的 localhost 对其他电脑没有意义。
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// 请求 `<url>/api/config` 核实对方是不是 Marvis 服务器。
//   - 网络错误或超时（3000 ms）：unreachable
//   - 非 2xx 或响应体不是 JSON 对象：not_marvis
//   - JSON 里没有 instance_id：too_old
export async function probeServer(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const base = normalizeServerAddress(url);
  if (!base) return { kind: "unreachable" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const res = await fetchImpl(`${base}${CONFIG_PATH}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { kind: "not_marvis" };

    const body = parseJsonObject(await res.text());
    if (!body) return { kind: "not_marvis" };

    return identityFromConfig(base, body);
  } catch {
    // 读取响应体途中超时也会走到这里，统一视为不可达。
    return { kind: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

function identityFromConfig(base: string, body: Record<string, unknown>): ProbeResult {
  const instanceId = stringField(body.instance_id);
  if (instanceId === "") return { kind: "too_old" };

  const host = new URL(base).hostname;
  const server: ServerIdentity = {
    url: base,
    name: stringField(body.server_name) || host,
    version: stringField(body.server_version),
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
