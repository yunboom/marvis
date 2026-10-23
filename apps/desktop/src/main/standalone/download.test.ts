// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DownloadAbortedError,
  DownloadChecksumError,
  type DownloadProgress,
  downloadResumable,
  sha256File,
} from "./download";

const SIZE = 256 * 1024;
const FAST_RETRY = { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 };
const noSleep = async () => {};

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

interface ServerState {
  data: Buffer;
  etag: string;
  requests: { path: string; headers: IncomingHttpHeaders }[];
  // 下一次响应在写出这么多字节后断开连接，用一次即清空。
  destroyAfter: number | null;
  // 在断开前调用一次，用于模拟文件在两次请求之间被替换。
  onDestroy: (() => void) | null;
  // 依次返回的数据，用于模拟一次校验错误的下载。
  overrides: Buffer[];
  // 返回 500 的路径。
  failPaths: Set<string>;
  // 每块之间的延迟，便于测试中止。
  chunkDelayMs: number;
}

let server: Server;
let base: string;
let state: ServerState;
let dir: string;

function startServer(): Promise<void> {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    state.requests.push({ path, headers: req.headers });

    if (state.failPaths.has(path)) {
      res.statusCode = 500;
      res.end("boom");
      return;
    }

    const body = state.overrides.shift() ?? state.data;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const ifRange = req.headers["if-range"];
    let start = 0;
    if (range && (!ifRange || ifRange === state.etag)) {
      start = Number(range[1]);
      if (start >= body.length) {
        res.statusCode = 416;
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${body.length - 1}/${body.length}`);
    } else {
      res.statusCode = 200;
    }
    res.setHeader("ETag", state.etag);
    res.setHeader("Content-Length", String(body.length - start));

    const slice = body.subarray(start);
    const destroyAfter = state.destroyAfter;
    state.destroyAfter = null;
    if (destroyAfter !== null) {
      res.flushHeaders();
      res.write(slice.subarray(0, destroyAfter), () => {
        state.onDestroy?.();
        state.onDestroy = null;
        setTimeout(() => res.destroy(), 20);
      });
      return;
    }

    if (state.chunkDelayMs > 0) {
      const chunk = 16 * 1024;
      let offset = 0;
      const tick = () => {
        if (res.destroyed) return;
        if (offset >= slice.length) {
          res.end();
          return;
        }
        res.write(slice.subarray(offset, offset + chunk));
        offset += chunk;
        setTimeout(tick, state.chunkDelayMs);
      };
      tick();
      return;
    }

    res.end(slice);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

beforeEach(async () => {
  state = {
    data: randomBytes(SIZE),
    etag: '"v1"',
    requests: [],
    destroyAfter: null,
    onDestroy: null,
    overrides: [],
    failPaths: new Set(),
    chunkDelayMs: 0,
  };
  dir = await mkdtemp(join(tmpdir(), "marvis-download-"));
  await startServer();
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

function baseOptions(dest: string) {
  return {
    urls: [`${base}/asset`],
    destPath: dest,
    expectedSize: SIZE,
    sha256: sha(state.data),
    sleep: noSleep,
    retry: FAST_RETRY,
  };
}

describe("downloadResumable", () => {
  it("downloads, verifies sha256 and cleans up part files", async () => {
    const dest = join(dir, "a.tar.xz");

    await downloadResumable(baseOptions(dest));

    expect(await readFile(dest)).toEqual(state.data);
    expect(await sha256File(dest)).toBe(sha(state.data));
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(existsSync(`${dest}.part.json`)).toBe(false);
    expect(state.requests).toHaveLength(1);
  });

  it("resumes with Range and If-Range after the connection drops mid-body", async () => {
    const dest = join(dir, "a.tar.xz");
    state.destroyAfter = 100 * 1024;
    const waiting: boolean[] = [];

    await downloadResumable({ ...baseOptions(dest), onWaitingForNetwork: (w) => waiting.push(w) });

    expect(await readFile(dest)).toEqual(state.data);
    expect(state.requests).toHaveLength(2);
    const second = state.requests[1].headers;
    expect(second.range).toMatch(/^bytes=\d+-$/);
    expect(Number(/\d+/.exec(second.range ?? "")?.[0])).toBeGreaterThan(0);
    expect(second["if-range"]).toBe('"v1"');
    expect(waiting).toEqual([true, false]);
  });

  it("restarts from scratch when the ETag changed between attempts", async () => {
    const dest = join(dir, "a.tar.xz");
    const next = randomBytes(SIZE);
    state.destroyAfter = 100 * 1024;
    state.onDestroy = () => {
      state.data = next;
      state.etag = '"v2"';
    };

    await downloadResumable({ ...baseOptions(dest), sha256: sha(next) });

    expect(await readFile(dest)).toEqual(next);
    expect(state.requests).toHaveLength(2);
    expect(state.requests[1].headers["if-range"]).toBe('"v1"');
  });

  it("downloads again from scratch after one checksum mismatch", async () => {
    const dest = join(dir, "a.tar.xz");
    state.overrides = [randomBytes(SIZE)];

    await downloadResumable(baseOptions(dest));

    expect(await readFile(dest)).toEqual(state.data);
    expect(state.requests).toHaveLength(2);
    expect(state.requests[1].headers.range).toBeUndefined();
  });

  it("throws DownloadChecksumError on a persistent mismatch", async () => {
    const dest = join(dir, "a.tar.xz");

    await expect(downloadResumable({ ...baseOptions(dest), sha256: "0".repeat(64) })).rejects.toBeInstanceOf(
      DownloadChecksumError,
    );

    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(state.requests).toHaveLength(2);
  });

  it("rejects with DownloadAbortedError on abort and keeps the part file", async () => {
    const dest = join(dir, "a.tar.xz");
    state.chunkDelayMs = 20;
    const controller = new AbortController();
    let aborted = false;

    const promise = downloadResumable({
      ...baseOptions(dest),
      signal: controller.signal,
      onProgress: (p) => {
        if (!aborted && p.receivedBytes > 0) {
          aborted = true;
          controller.abort();
        }
      },
    });
    // 节流下首个进度回调可能晚于首块数据，兜底再中止一次。
    setTimeout(() => controller.abort(), 60);

    await expect(promise).rejects.toBeInstanceOf(DownloadAbortedError);
    expect(existsSync(dest)).toBe(false);
    const partSize = (await stat(`${dest}.part`)).size;
    expect(partSize).toBeGreaterThan(0);
    expect(partSize).toBeLessThan(SIZE);
    expect(existsSync(`${dest}.part.json`)).toBe(true);
  });

  it("falls back to the next URL when the first returns 500", async () => {
    const dest = join(dir, "a.tar.xz");
    state.failPaths.add("/primary");

    await downloadResumable({ ...baseOptions(dest), urls: [`${base}/primary`, `${base}/mirror`] });

    expect(await readFile(dest)).toEqual(state.data);
    expect(state.requests.map((r) => r.path)).toEqual(["/primary", "/mirror"]);
  });

  it("makes no request when destPath already has the expected content", async () => {
    const dest = join(dir, "a.tar.xz");
    await downloadResumable(baseOptions(dest));
    state.requests = [];

    await downloadResumable(baseOptions(dest));

    expect(state.requests).toHaveLength(0);
  });

  it("reports increasing progress and a final call equal to size", async () => {
    const dest = join(dir, "a.tar.xz");
    state.chunkDelayMs = 50;
    const progress: DownloadProgress[] = [];

    await downloadResumable({ ...baseOptions(dest), onProgress: (p) => progress.push(p) });

    expect(progress.length).toBeGreaterThan(1);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].receivedBytes).toBeGreaterThanOrEqual(progress[i - 1].receivedBytes);
    }
    const last = progress[progress.length - 1];
    expect(last.receivedBytes).toBe(SIZE);
    expect(last.totalBytes).toBe(SIZE);
    expect(progress.some((p) => p.bytesPerSecond > 0)).toBe(true);
  });
});
