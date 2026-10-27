import type { StandaloneAsset, StandaloneManifest, StandalonePlatformKey } from "../../shared/standalone";

const PLATFORM_KEYS: readonly StandalonePlatformKey[] = [
  "darwin-amd64",
  "darwin-arm64",
  "linux-amd64",
  "linux-arm64",
  "windows-amd64",
  "windows-arm64",
];

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.xz$/;
const MANIFEST_TIMEOUT_MS = 15_000;

// manifest 拉取或解析失败。
export class ManifestError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAllowedUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function toAsset(value: unknown): StandaloneAsset | null {
  if (!isRecord(value)) return null;
  const { name, size, sha256, urls } = value;
  if (typeof name !== "string" || !ASSET_NAME_PATTERN.test(name) || name.includes("..")) return null;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) return null;
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) return null;
  if (!Array.isArray(urls) || urls.length === 0 || !urls.every(isAllowedUrl)) return null;

  return { name, size, sha256, urls: [...urls] };
}

// 只保留认识的平台；任何一个资源包不合法就整份作废，避免下载到半套资源。
function toAssets(value: unknown): Partial<Record<StandalonePlatformKey, StandaloneAsset>> | null {
  if (!isRecord(value)) return null;
  const out: Partial<Record<StandalonePlatformKey, StandaloneAsset>> = {};
  for (const key of PLATFORM_KEYS) {
    if (!(key in value)) continue;
    const asset = toAsset(value[key]);
    if (!asset) return null;
    out[key] = asset;
  }
  return out;
}

// 把未知输入收窄为 manifest，字段缺失或不合法时返回 null。
export function parseManifest(value: unknown): StandaloneManifest | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const { version, minAppVersion, server, postgres } = value;
  if (typeof version !== "string" || !version) return null;
  if (typeof minAppVersion !== "string") return null;
  const serverAssets = toAssets(server);
  if (!serverAssets || !isRecord(postgres) || typeof postgres.version !== "string" || !postgres.version) return null;
  const postgresAssets = toAssets(postgres.assets);
  if (!postgresAssets) return null;

  return {
    schemaVersion: 1,
    version,
    minAppVersion,
    server: serverAssets,
    postgres: { version: postgres.version, assets: postgresAssets },
  };
}

// 拉取并解析 manifest；网络错误、非 2xx、内容不合法都抛 ManifestError。
export async function fetchManifest(url: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<StandaloneManifest> {
  const timeout = AbortSignal.timeout(MANIFEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      redirect: "follow",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    throw new ManifestError(`fetch manifest ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new ManifestError(`fetch manifest ${url}: HTTP ${res.status}`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ManifestError(`fetch manifest ${url}: invalid JSON`);
  }
  const manifest = parseManifest(body);
  if (!manifest) throw new ManifestError(`fetch manifest ${url}: unexpected shape`);

  return manifest;
}

// 比较 x.y.z[-pre] 形式的版本号（可带 v 前缀）：数字段逐段比较，缺段按 0；预发布版本小于同号正式版。
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre = ""] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const diff = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}
