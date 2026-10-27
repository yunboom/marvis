// 单机模式的服务端进程：执行数据库迁移、启动服务端、等待就绪、清理上次残留的进程。
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, open, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import type { CommandRunner } from "./postgres";

// 服务端资源包目录（含 server、migrate、migrations/）及其日志、pid 文件。
export interface ServerBundlePaths {
  dir: string;
  logFile: string;
  pidFile: string;
}

// 运行中的服务端进程。
export interface ServerHandle {
  pid: number;
  exited: Promise<number | null>;
  stop(timeoutMs?: number): Promise<void>;
}

const WINDOWS_PLATFORM: NodeJS.Platform = "win32";
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;
const MIGRATE_UP_ARG = "up";
const SERVER_BINARY = "server";
const MIGRATE_TIMEOUT_MS = 10 * 60 * 1000;
const STOP_TIMEOUT_MS = 10_000;
const READY_PATH = "/readyz";
const READY_TIMEOUT_MS = 120_000;
const READY_INTERVAL_MS = 500;
const READY_REQUEST_TIMEOUT_MS = 5_000;
const HTTP_OK = 200;
const STALE_KILL_TIMEOUT_MS = 5_000;
const STALE_POLL_INTERVAL_MS = 100;
const TAIL_DEFAULT_BYTES = 16 * 1024;
const SIGNAL_TERM: NodeJS.Signals = "SIGTERM";
const SIGNAL_KILL: NodeJS.Signals = "SIGKILL";
const ERRNO_NOT_FOUND = "ENOENT";

const execFileAsync = promisify(execFile);

// 基于 execFile 的 CommandRunner：退出码非 0 时 reject，Error 带 stdout / stderr / code。
export const execFileRunner: CommandRunner = async (file, args, options = {}) => {
  const { stdout, stderr } = await execFileAsync(file, args, {
    env: options.env,
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: EXEC_MAX_BUFFER,
    windowsHide: true,
    encoding: "utf8",
  });

  return { stdout, stderr };
};

// 不接管输出的 CommandRunner：子进程的标准输入输出都指向空设备，退出码非 0 时 reject。
// pg_ctl start 在 Windows 上会把继承的句柄交给常驻的 postmaster，用管道的话要等到超时才返回。
export const noPipeRunner: CommandRunner = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: options.env, cwd: options.cwd, stdio: "ignore", windowsHide: true });
    const timer = options.timeoutMs ? setTimeout(() => child.kill(SIGNAL_KILL), options.timeoutMs) : undefined;

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: "", stderr: "" });
      else reject(Object.assign(new Error(`${file} exited with ${code ?? signal}`), { code }));
    });
  });

// 资源包内可执行文件的路径；Windows 带 .exe 后缀。
export function bundleBinary(
  dir: string,
  name: "server" | "migrate",
  platform: NodeJS.Platform = process.platform,
): string {
  const file = platform === WINDOWS_PLATFORM ? `${name}.exe` : name;

  return join(dir, file);
}

async function appendOutput(logFile: string, output: { stdout?: string; stderr?: string }): Promise<void> {
  const text = `${output.stdout ?? ""}${output.stderr ?? ""}`;
  if (text) await appendFile(logFile, text);
}

// 执行 `migrate up`，输出追加到日志文件；失败时原样抛出。
export async function runMigrations(
  paths: ServerBundlePaths,
  env: NodeJS.ProcessEnv,
  run: CommandRunner = execFileRunner,
): Promise<void> {
  let output: { stdout?: string; stderr?: string };
  try {
    output = await run(bundleBinary(paths.dir, "migrate"), [MIGRATE_UP_ARG], {
      env,
      cwd: paths.dir,
      timeoutMs: MIGRATE_TIMEOUT_MS,
    });
  } catch (err) {
    await appendOutput(paths.logFile, err as { stdout?: string; stderr?: string });
    throw err;
  }

  await appendOutput(paths.logFile, output);
}

// 启动服务端；env 由调用方构造完整，不合并 process.env。
export function startServerProcess(
  paths: ServerBundlePaths,
  env: NodeJS.ProcessEnv,
  spawnImpl: typeof spawn = spawn,
): ServerHandle {
  const log = createWriteStream(paths.logFile, { flags: "a" });
  const child = spawnImpl(bundleBinary(paths.dir, "server"), [], {
    cwd: paths.dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  let exitCode: number | null | undefined;
  const exited = new Promise<number | null>((resolve) => {
    const finish = (code: number | null): void => {
      if (exitCode !== undefined) return;
      exitCode = code;
      log.end();
      resolve(code);
    };
    child.once("exit", (code) => finish(code));
    // 可执行文件不存在等启动失败只触发 error，不触发 exit。
    child.once("error", (err) => {
      log.write(`failed to start server: ${err.message}\n`);
      finish(null);
    });
  });

  const pid = child.pid ?? 0;
  // pid 文件供下次启动清理崩溃残留的进程；写失败不影响本次运行。
  const pidWritten = pid > 0 ? writeFile(paths.pidFile, String(pid)).catch(() => undefined) : Promise.resolve();

  async function stop(timeoutMs: number = STOP_TIMEOUT_MS): Promise<void> {
    if (exitCode === undefined) {
      child.kill(SIGNAL_TERM);
      const timer = setTimeout(() => {
        if (exitCode === undefined) child.kill(SIGNAL_KILL);
      }, timeoutMs);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }

    await pidWritten;
    await rm(paths.pidFile, { force: true });
  }

  return { pid, exited, stop };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// 轮询 `<baseUrl>/readyz` 直到返回 200；进程先退出、超时或被中止时 reject。
export async function waitForReady(
  baseUrl: string,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    exited?: Promise<number | null>;
  } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? READY_INTERVAL_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, "")}${READY_PATH}`;

  // 进程退出或超时都会中止本轮请求与等待。
  const controller = new AbortController();
  const stopWith = (reason: Error): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const timeoutTimer = setTimeout(
    () => stopWith(new Error(`server not ready within ${timeoutMs} ms`)),
    timeoutMs,
  );
  const onExternalAbort = (): void => stopWith(new Error("waiting for server readiness was aborted"));
  if (opts.signal?.aborted) onExternalAbort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
  void opts.exited?.then((code) => stopWith(new Error(`server exited with code ${code} before becoming ready`)));

  try {
    for (;;) {
      const request = new AbortController();
      const onAbort = (): void => request.abort();
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const requestTimer = setTimeout(() => request.abort(), READY_REQUEST_TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, { signal: request.signal });
        await res.body?.cancel().catch(() => undefined);
        if (res.status === HTTP_OK) return;
      } catch {
        // 连接被拒、单次超时：继续轮询。
      } finally {
        clearTimeout(requestTimer);
        controller.signal.removeEventListener("abort", onAbort);
      }

      if (controller.signal.aborted) throw controller.signal.reason;
      await sleep(intervalMs, controller.signal);
    }
  } finally {
    clearTimeout(timeoutTimer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}

function isAlive(pid: number, kill: (pid: number, signal?: NodeJS.Signals | 0) => void): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch {
    // ESRCH：进程已不存在；EPERM：进程不属于当前用户，多半是 pid 被复用，不去动它。
    return false;
  }
}

async function waitForExit(
  pid: number,
  kill: (pid: number, signal?: NodeJS.Signals | 0) => void,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid, kill)) return true;
    await sleep(STALE_POLL_INTERVAL_MS);
  }

  return !isAlive(pid, kill);
}

// pid 对应的进程是否是资源包里的服务端：崩溃后 pid 可能已被其他程序复用，不能只凭 pid 结束进程。
export async function isServerProcess(
  pid: number,
  run: CommandRunner = execFileRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const image = platform === WINDOWS_PLATFORM ? `${SERVER_BINARY}.exe` : SERVER_BINARY;
  try {
    if (platform === WINDOWS_PLATFORM) {
      const { stdout } = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
      return stdout.toLowerCase().includes(`"${image}"`);
    }
    const { stdout } = await run("ps", ["-p", String(pid), "-o", "comm="]);
    return basename(stdout.trim()) === image;
  } catch {
    return false;
  }
}

// 清理上次崩溃残留的服务端进程：存活则先 SIGTERM，超时再 SIGKILL；返回是否结束了进程。
export async function killStaleProcess(
  pidFile: string,
  kill: (pid: number, signal?: NodeJS.Signals | 0) => void = process.kill.bind(process),
  isOurs: (pid: number) => Promise<boolean> = (pid) => isServerProcess(pid),
): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(pidFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === ERRNO_NOT_FOUND) return false;
    throw err;
  }

  const pid = Number.parseInt(content.trim(), 10);
  let killed = false;
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid, kill) && (await isOurs(pid))) {
    kill(pid, SIGNAL_TERM);
    if (!(await waitForExit(pid, kill, STALE_KILL_TIMEOUT_MS))) {
      kill(pid, SIGNAL_KILL);
      await waitForExit(pid, kill, STALE_KILL_TIMEOUT_MS);
    }
    killed = true;
  }

  await rm(pidFile, { force: true });

  return killed;
}

// 读取日志文件末尾 maxBytes 字节；文件不存在时返回空串。
export async function tailFile(path: string, maxBytes: number = TAIL_DEFAULT_BYTES): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === ERRNO_NOT_FOUND) return "";
    throw err;
  }

  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);

    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}
