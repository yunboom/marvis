// @vitest-environment node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bundleBinary,
  killStaleProcess,
  runMigrations,
  startServerProcess,
  tailFile,
  waitForReady,
  type ServerBundlePaths,
} from "./server-process";

const isWindows = process.platform === "win32";

async function writeScript(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

function waitForLog(path: string, text: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = async (): Promise<void> => {
      const content = await readFile(path, "utf8").catch(() => "");
      if (content.includes(text)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`log never contained ${text}`));
      setTimeout(check, 20);
    };
    void check();
  });
}

describe("server process", () => {
  let dir: string;
  let paths: ServerBundlePaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "marvis-server-test-"));
    paths = { dir, logFile: join(dir, "server.log"), pidFile: join(dir, "server.pid") };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves binaries with .exe on Windows only", () => {
    expect(bundleBinary("/b", "server", "darwin")).toBe(join("/b", "server"));
    expect(bundleBinary("/b", "migrate", "win32")).toBe(join("/b", "migrate.exe"));
  });

  it.skipIf(isWindows)("runs migrations in the bundle dir and logs output", async () => {
    await writeScript(bundleBinary(dir, "migrate"), 'echo "migrated $1 in $(pwd) db=$DATABASE_URL"');

    await runMigrations(paths, { DATABASE_URL: "postgres://x", PATH: process.env.PATH });

    const log = await readFile(paths.logFile, "utf8");
    expect(log).toContain("migrated up in");
    expect(log).toContain("db=postgres://x");
    expect(log).toContain(await realpath(dir));
  });

  it.skipIf(isWindows)("rejects when migrations fail and keeps their output", async () => {
    await writeScript(bundleBinary(dir, "migrate"), 'echo "boom" >&2\nexit 1');

    await expect(runMigrations(paths, { PATH: process.env.PATH })).rejects.toThrow();

    expect(await readFile(paths.logFile, "utf8")).toContain("boom");
  });

  it.skipIf(isWindows)("starts the server, logs output and stops it with SIGTERM", async () => {
    await writeScript(
      bundleBinary(dir, "server"),
      'trap "echo terminated; exit 0" TERM\necho "server up $MARVIS_X"\nwhile true; do sleep 0.1; done',
    );

    const handle = startServerProcess(paths, { MARVIS_X: "hello", PATH: process.env.PATH });
    expect(handle.pid).toBeGreaterThan(0);
    await waitForLog(paths.logFile, "server up hello");
    expect((await readFile(paths.pidFile, "utf8")).trim()).toBe(String(handle.pid));

    await handle.stop();

    expect(await handle.exited).toBe(0);
    expect(existsSync(paths.pidFile)).toBe(false);
    await waitForLog(paths.logFile, "terminated");
  });

  it.skipIf(isWindows)("falls back to SIGKILL when SIGTERM is ignored", async () => {
    await writeScript(
      bundleBinary(dir, "server"),
      'trap "" TERM\necho "stubborn"\nwhile true; do sleep 0.1; done',
    );

    const handle = startServerProcess(paths, { PATH: process.env.PATH });
    await waitForLog(paths.logFile, "stubborn");

    const started = Date.now();
    await handle.stop(300);

    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(await handle.exited).toBeNull();
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it("resolves exited when the binary is missing", async () => {
    const handle = startServerProcess(paths, {});

    expect(await handle.exited).toBeNull();
    await handle.stop();
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it("waits until /readyz returns 200", async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      expect(req.url).toBe("/readyz");
      hits += 1;
      res.statusCode = hits <= 2 ? 503 : 200;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await waitForReady(`http://127.0.0.1:${port}`, { intervalMs: 10, timeoutMs: 5000 });
      expect(hits).toBe(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects early when the process exits", async () => {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => (exit = resolve));
    const fetchImpl = (async () => new Response(null, { status: 503 })) as typeof fetch;
    setTimeout(() => exit(3), 50);

    const started = Date.now();
    await expect(
      waitForReady("http://127.0.0.1:1", { fetchImpl, exited, intervalMs: 10, timeoutMs: 10_000 }),
    ).rejects.toThrow(/code 3/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("rejects on timeout", async () => {
    const fetchImpl = (async () => new Response(null, { status: 503 })) as typeof fetch;

    await expect(waitForReady("http://x", { fetchImpl, intervalMs: 10, timeoutMs: 100 })).rejects.toThrow(
      /not ready within 100 ms/,
    );
  });

  it.skipIf(isWindows)("kills a stale process recorded in the pid file", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const gone = new Promise((resolve) => child.once("exit", resolve));
    await writeFile(paths.pidFile, String(child.pid));

    expect(await killStaleProcess(paths.pidFile)).toBe(true);

    await gone;
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it("ignores missing or dead pid files", async () => {
    expect(await killStaleProcess(paths.pidFile)).toBe(false);

    await writeFile(paths.pidFile, "999999");
    const dead = (): void => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    };
    expect(await killStaleProcess(paths.pidFile, dead)).toBe(false);
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it("tails the end of a log file", async () => {
    expect(await tailFile(join(dir, "missing.log"))).toBe("");

    await writeFile(paths.logFile, "0123456789");
    expect(await tailFile(paths.logFile, 4)).toBe("6789");
    expect(await tailFile(paths.logFile)).toBe("0123456789");
  });
});
