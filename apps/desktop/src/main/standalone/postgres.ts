// 单机模式的本地 PostgreSQL：用便携版的 initdb / pg_ctl 初始化、启动和停止数据目录。
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execFileRunner, noPipeRunner, tailFile } from "./server-process";

// 执行外部命令；退出码非 0 时 reject，Error 上带 stdout / stderr / code。
export type CommandRunner = (
  file: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

// PostgreSQL 便携包的 bin 目录、数据目录与日志文件。
export interface PostgresPaths {
  binDir: string;
  dataDir: string;
  logFile: string;
}

export const POSTGRES_USER = "marvis";
export const POSTGRES_DATABASE = "postgres";

const LOOPBACK_HOST = "127.0.0.1";
const WINDOWS_PLATFORM: NodeJS.Platform = "win32";
const PG_VERSION_FILE = "PG_VERSION";
const POSTMASTER_PID_FILE = "postmaster.pid";
const POSTGRESQL_CONF_FILE = "postgresql.conf";
const PWFILE_NAME = "pwfile";
const INITDB_TIMEOUT_MS = 120_000;
// pg_ctl -w 自身等待 60 秒，外层超时再留余量。
const PG_CTL_START_WAIT_S = 60;
const PG_CTL_STOP_WAIT_S = 30;
const PG_CTL_EXTRA_TIMEOUT_MS = 15_000;
const PG_LOG_TAIL_BYTES = 4 * 1024;

// pg_ctl stop 在服务未运行时的输出，视为已停止。
const NOT_RUNNING_PATTERNS = [/is server running\?/i, /no server running/i, /does not exist/i];

// 便携包内可执行文件的路径；Windows 带 .exe 后缀。
export function postgresBinary(
  binDir: string,
  name: "initdb" | "pg_ctl",
  platform: NodeJS.Platform = process.platform,
): string {
  const file = platform === WINDOWS_PLATFORM ? `${name}.exe` : name;

  return join(binDir, file);
}

// 检查端口在 host 上能否监听。
export async function isPortFree(port: number, host: string = LOOPBACK_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

// 让系统分配一个空闲端口。
export async function findFreePort(host: string = LOOPBACK_HOST): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0, host, exclusive: true }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("failed to resolve a free port")));
        return;
      }

      server.close(() => resolve(address.port));
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// 初始化数据目录；已初始化（存在 PG_VERSION）时不做任何事并返回 false。
export async function initPostgres(
  paths: PostgresPaths,
  opts: { password: string; run?: CommandRunner },
): Promise<boolean> {
  if (await exists(join(paths.dataDir, PG_VERSION_FILE))) return false;

  const run = opts.run ?? execFileRunner;

  // 密码经临时文件传给 initdb，避免出现在命令行参数里。
  const tempDir = await mkdtemp(join(tmpdir(), "marvis-pg-"));
  const pwfile = join(tempDir, PWFILE_NAME);
  try {
    await writeFile(pwfile, `${opts.password}\n`, { mode: 0o600 });
    await run(
      postgresBinary(paths.binDir, "initdb"),
      [
        "-D",
        paths.dataDir,
        "-U",
        POSTGRES_USER,
        "--auth=scram-sha-256",
        `--pwfile=${pwfile}`,
        "-E",
        "UTF8",
        "--locale=C",
      ],
      { timeoutMs: INITDB_TIMEOUT_MS },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  await appendFile(join(paths.dataDir, POSTGRESQL_CONF_FILE), `\nlisten_addresses = '${LOOPBACK_HOST}'\n`);

  return true;
}

// 启动 PostgreSQL 并等待其可接受连接。
export async function startPostgres(
  paths: PostgresPaths,
  opts: { port: number; run?: CommandRunner },
): Promise<void> {
  const run = opts.run ?? noPipeRunner;

  try {
    await run(
      postgresBinary(paths.binDir, "pg_ctl"),
      [
        "-D",
        paths.dataDir,
        "-l",
        paths.logFile,
        "-w",
        "-t",
        String(PG_CTL_START_WAIT_S),
        "-o",
        `-p ${opts.port} -c listen_addresses=${LOOPBACK_HOST}`,
        "start",
      ],
      { timeoutMs: PG_CTL_START_WAIT_S * 1000 + PG_CTL_EXTRA_TIMEOUT_MS },
    );
  } catch (err) {
    // pg_ctl 的输出不经管道，失败原因在数据库日志里。
    const log = await tailFile(paths.logFile, PG_LOG_TAIL_BYTES).catch(() => "");
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${log}`.trim(), { cause: err });
  }
}

function isNotRunningError(err: unknown): boolean {
  const e = err as { message?: string; stdout?: string; stderr?: string };
  const text = [e?.message, e?.stdout, e?.stderr].filter(Boolean).join("\n");

  return NOT_RUNNING_PATTERNS.some((pattern) => pattern.test(text));
}

// 快速停止 PostgreSQL；本来就没在运行时视为成功。
export async function stopPostgres(paths: PostgresPaths, opts: { run?: CommandRunner } = {}): Promise<void> {
  if (!(await exists(join(paths.dataDir, POSTMASTER_PID_FILE)))) return;

  const run = opts.run ?? execFileRunner;
  try {
    await run(
      postgresBinary(paths.binDir, "pg_ctl"),
      ["-D", paths.dataDir, "-m", "fast", "-w", "-t", String(PG_CTL_STOP_WAIT_S), "stop"],
      { timeoutMs: PG_CTL_STOP_WAIT_S * 1000 + PG_CTL_EXTRA_TIMEOUT_MS },
    );
  } catch (err) {
    if (isNotRunningError(err)) return;
    throw err;
  }
}

// 服务端使用的连接串。
export function postgresUrl(opts: { port: number; password: string }): string {
  const password = encodeURIComponent(opts.password);

  return `postgres://${POSTGRES_USER}:${password}@${LOOPBACK_HOST}:${opts.port}/${POSTGRES_DATABASE}?sslmode=disable`;
}
