// 单机模式资源包下载：多地址回退、断点续传、指数退避重试、进度节流与 sha256 校验。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
}

export interface DownloadOptions {
  // 依次尝试；网络或 HTTP 失败时换下一个地址。
  urls: string[];
  // 最终文件；未完成的数据在 destPath + ".part"，续传元数据在 destPath + ".part.json"。
  destPath: string;
  expectedSize: number;
  // 小写十六进制。
  sha256: string;
  // 中止即暂停或取消：保留 .part 以便之后续传，并以 DownloadAbortedError 拒绝。
  signal?: AbortSignal;
  // 至多每 200ms 一次，完成时再补一次；bytesPerSecond 为 3 秒滑动平均。
  onProgress?: (p: DownloadProgress) => void;
  // 网络错误后退避等待时为 true，数据重新流动时为 false。
  onWaitingForNetwork?: (waiting: boolean) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  retry?: { attempts: number; baseDelayMs: number; maxDelayMs: number };
}

export class DownloadAbortedError extends Error {
  constructor(message = "download aborted") {
    super(message);
    this.name = "DownloadAbortedError";
  }
}

export class DownloadChecksumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadChecksumError";
  }
}

export class DownloadNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadNetworkError";
  }
}

const PART_SUFFIX = ".part";
const META_SUFFIX = ".part.json";

const PROGRESS_INTERVAL_MS = 200;
const SPEED_WINDOW_MS = 3000;

// 校验失败后从头重下的次数上限（含首次下载共 2 次）。
const MAX_CHECKSUM_ATTEMPTS = 2;

const DEFAULT_RETRY = { attempts: 8, baseDelayMs: 1000, maxDelayMs: 30000 };

const HTTP_OK = 200;
const HTTP_PARTIAL_CONTENT = 206;
const HTTP_RANGE_NOT_SATISFIABLE = 416;

const HEADER_RANGE = "Range";
const HEADER_IF_RANGE = "If-Range";
const HEADER_ETAG = "etag";
const HEADER_CONTENT_RANGE = "content-range";

const FILE_FLAG_APPEND = "a";
const FILE_FLAG_WRITE = "w";

const CONTENT_RANGE_START = /^bytes\s+(\d+)-/i;

// 续传元数据：只记录原始地址，GitHub 重定向后的签名地址会过期，绝不保存。
interface PartMeta {
  url: string;
  etag: string | null;
  totalBytes: number;
}

// 一次请求失败的原因：网络类错误可重试，其余错误直接抛出。
class AttemptNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttemptNetworkError";
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);

  return hash.digest("hex");
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DownloadAbortedError());
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(new DownloadAbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readMeta(path: string): Promise<PartMeta | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PartMeta>;
    if (typeof parsed.url !== "string") return null;

    return {
      url: parsed.url,
      etag: typeof parsed.etag === "string" ? parsed.etag : null,
      totalBytes: typeof parsed.totalBytes === "number" ? parsed.totalBytes : 0,
    };
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// 进度节流与 3 秒滑动平均速度。
class ProgressTracker {
  private samples: { time: number; bytes: number }[] = [];
  private lastEmit = 0;

  constructor(
    private readonly totalBytes: number,
    private readonly onProgress?: (p: DownloadProgress) => void,
  ) {}

  // 每次请求开始时记下起点，避免把续传前已有的字节算进速度。
  reset(bytes: number): void {
    this.samples = [{ time: Date.now(), bytes }];
  }

  update(bytes: number): void {
    const now = Date.now();
    this.samples.push({ time: now, bytes });
    while (this.samples.length > 2 && now - this.samples[1].time >= SPEED_WINDOW_MS) this.samples.shift();

    if (now - this.lastEmit < PROGRESS_INTERVAL_MS) return;

    this.lastEmit = now;
    this.emit(bytes);
  }

  finish(bytes: number): void {
    this.lastEmit = Date.now();
    this.emit(bytes);
  }

  private emit(bytes: number): void {
    if (!this.onProgress) return;

    this.onProgress({ receivedBytes: bytes, totalBytes: this.totalBytes, bytesPerSecond: this.speed() });
  }

  private speed(): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last) return 0;

    const elapsed = last.time - first.time;
    if (elapsed <= 0) return 0;

    return Math.round(((last.bytes - first.bytes) * 1000) / elapsed);
  }
}

interface Paths {
  part: string;
  meta: string;
}

async function clearPart(paths: Paths): Promise<void> {
  await rm(paths.part, { force: true });
  await rm(paths.meta, { force: true });
}

// 发起一次请求并把响应体写入 .part；返回本次是否收到了新数据。
async function attemptOnce(
  opts: DownloadOptions,
  url: string,
  paths: Paths,
  tracker: ProgressTracker,
  onBytes: () => void,
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  let partSize = await fileSize(paths.part);
  if (partSize > opts.expectedSize) {
    await clearPart(paths);
    partSize = 0;
  }

  const meta = await readMeta(paths.meta);
  const headers: Record<string, string> = {};
  if (partSize > 0) {
    headers[HEADER_RANGE] = `bytes=${partSize}-`;
    if (meta?.etag && meta.url === url) headers[HEADER_IF_RANGE] = meta.etag;
  }

  tracker.reset(partSize);

  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: opts.signal, redirect: "follow" });
  } catch (err) {
    throw new AttemptNetworkError(`request failed: ${url}: ${errorMessage(err)}`);
  }

  if (res.status === HTTP_RANGE_NOT_SATISFIABLE && partSize === opts.expectedSize) {
    await res.body?.cancel().catch(() => {});
    return false;
  }

  let offset: number;
  if (res.status === HTTP_PARTIAL_CONTENT && partSize > 0) {
    const match = CONTENT_RANGE_START.exec(res.headers.get(HEADER_CONTENT_RANGE) ?? "");
    if (!match || Number(match[1]) !== partSize) {
      // 服务端返回的区间对不上已有数据，丢弃 .part 下次从头开始。
      await res.body?.cancel().catch(() => {});
      await clearPart(paths);
      throw new AttemptNetworkError(`unexpected content-range from ${url}`);
    }
    offset = partSize;
  } else if (res.status === HTTP_OK) {
    // 200 说明文件已变或服务端不支持区间请求，从头重写。
    offset = 0;
  } else {
    await res.body?.cancel().catch(() => {});
    if (res.status === HTTP_RANGE_NOT_SATISFIABLE) await clearPart(paths);
    throw new AttemptNetworkError(`unexpected HTTP status ${res.status} from ${url}`);
  }

  if (!res.body) throw new AttemptNetworkError(`empty response body from ${url}`);

  const etag = res.headers.get(HEADER_ETAG) ?? (meta?.url === url && offset > 0 ? meta.etag : null);
  const newMeta: PartMeta = { url, etag, totalBytes: opts.expectedSize };
  await writeFile(paths.meta, JSON.stringify(newMeta));

  const file = await open(paths.part, offset > 0 ? FILE_FLAG_APPEND : FILE_FLAG_WRITE);
  const reader = res.body.getReader();
  let received = offset;
  let progressed = false;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw new AttemptNetworkError(`stream failed: ${url}: ${errorMessage(err)}`);
      }
      if (chunk.done) break;

      // 写盘错误（如磁盘已满）不属于网络错误，直接抛出。
      await file.write(chunk.value);
      received += chunk.value.byteLength;
      if (!progressed) {
        progressed = true;
        onBytes();
      }
      tracker.update(received);

      if (received > opts.expectedSize) {
        await reader.cancel().catch(() => {});
        await file.close();
        await clearPart(paths);
        throw new AttemptNetworkError(`response from ${url} exceeds expected size ${opts.expectedSize}`);
      }
    }
  } finally {
    reader.releaseLock();
    await file.close().catch(() => {});
  }

  if (received < opts.expectedSize) {
    throw new AttemptNetworkError(`response from ${url} ended early at ${received}/${opts.expectedSize} bytes`);
  }

  return progressed;
}

// 把数据下载到 .part，直到大小达到 expectedSize。
async function downloadToPart(opts: DownloadOptions, paths: Paths, tracker: ProgressTracker): Promise<void> {
  const retry = opts.retry ?? DEFAULT_RETRY;
  const sleep = opts.sleep ?? defaultSleep;

  let urlIndex = 0;
  let failures = 0;
  let waiting = false;
  const setWaiting = (value: boolean) => {
    if (waiting === value) return;

    waiting = value;
    opts.onWaitingForNetwork?.(value);
  };

  for (;;) {
    if (opts.signal?.aborted) throw new DownloadAbortedError();

    if ((await fileSize(paths.part)) === opts.expectedSize) {
      tracker.finish(opts.expectedSize);
      setWaiting(false);
      return;
    }

    const url = opts.urls[urlIndex];
    let progressed = false;
    try {
      await attemptOnce(opts, url, paths, tracker, () => {
        progressed = true;
        failures = 0;
        setWaiting(false);
      });
      continue;
    } catch (err) {
      if (opts.signal?.aborted) throw new DownloadAbortedError();
      if (!(err instanceof AttemptNetworkError)) throw err;

      failures += 1;
      if (failures >= retry.attempts) {
        setWaiting(false);
        throw new DownloadNetworkError(`download failed after ${failures} attempts: ${err.message}`);
      }

      // 本次有数据流入时留在原地址续传，否则换下一个地址。
      if (!progressed) urlIndex = (urlIndex + 1) % opts.urls.length;

      setWaiting(true);
      const delay = Math.min(retry.baseDelayMs * 2 ** (failures - 1), retry.maxDelayMs);
      try {
        await sleep(delay, opts.signal);
      } catch {
        throw new DownloadAbortedError();
      }
      if (opts.signal?.aborted) throw new DownloadAbortedError();
    }
  }
}

export async function downloadResumable(opts: DownloadOptions): Promise<void> {
  if (opts.urls.length === 0) throw new Error("no download urls");

  const expected = opts.sha256.toLowerCase();
  if ((await fileExists(opts.destPath)) && (await sha256File(opts.destPath)) === expected) return;

  if (opts.signal?.aborted) throw new DownloadAbortedError();

  const paths: Paths = { part: opts.destPath + PART_SUFFIX, meta: opts.destPath + META_SUFFIX };
  await mkdir(dirname(opts.destPath), { recursive: true });

  const tracker = new ProgressTracker(opts.expectedSize, opts.onProgress);
  let actual = "";
  for (let attempt = 0; attempt < MAX_CHECKSUM_ATTEMPTS; attempt++) {
    await downloadToPart(opts, paths, tracker);

    actual = await sha256File(paths.part);
    if (actual === expected) {
      await rename(paths.part, opts.destPath);
      await rm(paths.meta, { force: true });
      return;
    }

    await clearPart(paths);
  }

  throw new DownloadChecksumError(`sha256 mismatch for ${opts.destPath}: expected ${expected}, got ${actual}`);
}
