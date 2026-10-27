// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findFreePort,
  initPostgres,
  isPortFree,
  POSTGRES_USER,
  postgresBinary,
  postgresUrl,
  startPostgres,
  stopPostgres,
  type CommandRunner,
  type PostgresPaths,
} from "./postgres";

interface Call {
  file: string;
  args: string[];
  pwfileContent?: string;
}

// 记录调用的假 runner；initdb 时顺带读出 pwfile 内容并模拟生成 postgresql.conf。
function fakeRunner(calls: Call[], fail?: Error): CommandRunner {
  return async (file, args) => {
    const call: Call = { file, args };
    const pw = args.find((a) => a.startsWith("--pwfile="));
    if (pw) {
      const pwPath = pw.slice("--pwfile=".length);
      call.pwfileContent = await readFile(pwPath, "utf8");
      const dataDir = args[args.indexOf("-D") + 1];
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, "postgresql.conf"), "# generated\n");
    }
    calls.push(call);
    if (fail) throw fail;

    return { stdout: "", stderr: "" };
  };
}

describe("postgres", () => {
  let dir: string;
  let paths: PostgresPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "marvis-pg-test-"));
    paths = { binDir: join(dir, "bin"), dataDir: join(dir, "data"), logFile: join(dir, "pg.log") };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves binaries with .exe on Windows only", () => {
    expect(postgresBinary("/b", "initdb", "darwin")).toBe(join("/b", "initdb"));
    expect(postgresBinary("/b", "pg_ctl", "linux")).toBe(join("/b", "pg_ctl"));
    expect(postgresBinary("/b", "initdb", "win32")).toBe(join("/b", "initdb.exe"));
    expect(postgresBinary("/b", "pg_ctl", "win32")).toBe(join("/b", "pg_ctl.exe"));
  });

  it("initializes the data directory with a temporary pwfile", async () => {
    const calls: Call[] = [];

    const created = await initPostgres(paths, { password: "s3cret", run: fakeRunner(calls) });

    expect(created).toBe(true);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.file).toBe(postgresBinary(paths.binDir, "initdb"));
    const pwArg = call.args.find((a) => a.startsWith("--pwfile="))!;
    expect(call.args).toEqual([
      "-D",
      paths.dataDir,
      "-U",
      POSTGRES_USER,
      "--auth=scram-sha-256",
      pwArg,
      "-E",
      "UTF8",
      "--locale=C",
    ]);
    expect(call.pwfileContent).toBe("s3cret\n");
    expect(existsSync(pwArg.slice("--pwfile=".length))).toBe(false);
    const conf = await readFile(join(paths.dataDir, "postgresql.conf"), "utf8");
    expect(conf).toContain("listen_addresses = '127.0.0.1'");
  });

  it("deletes the pwfile when initdb fails", async () => {
    const calls: Call[] = [];

    await expect(
      initPostgres(paths, { password: "x", run: fakeRunner(calls, new Error("initdb failed")) }),
    ).rejects.toThrow("initdb failed");

    const pwArg = calls[0].args.find((a) => a.startsWith("--pwfile="))!;
    expect(existsSync(pwArg.slice("--pwfile=".length))).toBe(false);
  });

  it("is a no-op when PG_VERSION exists", async () => {
    await mkdir(paths.dataDir, { recursive: true });
    await writeFile(join(paths.dataDir, "PG_VERSION"), "17\n");
    const calls: Call[] = [];

    const created = await initPostgres(paths, { password: "x", run: fakeRunner(calls) });

    expect(created).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("starts with pg_ctl on the given port", async () => {
    const calls: Call[] = [];

    await startPostgres(paths, { port: 54321, run: fakeRunner(calls) });

    expect(calls).toEqual([
      {
        file: postgresBinary(paths.binDir, "pg_ctl"),
        args: [
          "-D",
          paths.dataDir,
          "-l",
          paths.logFile,
          "-w",
          "-t",
          "60",
          "-o",
          "-p 54321 -c listen_addresses=127.0.0.1",
          "start",
        ],
      },
    ]);
  });

  it("stops with pg_ctl fast mode", async () => {
    await mkdir(paths.dataDir, { recursive: true });
    await writeFile(join(paths.dataDir, "postmaster.pid"), "123\n");
    const calls: Call[] = [];

    await stopPostgres(paths, { run: fakeRunner(calls) });

    expect(calls).toEqual([
      {
        file: postgresBinary(paths.binDir, "pg_ctl"),
        args: ["-D", paths.dataDir, "-m", "fast", "-w", "-t", "30", "stop"],
      },
    ]);
  });

  it("treats a stopped server as success", async () => {
    const calls: Call[] = [];

    // 没有 postmaster.pid：不调用 pg_ctl。
    await stopPostgres(paths, { run: fakeRunner(calls) });
    expect(calls).toHaveLength(0);

    // pid 文件残留但 pg_ctl 报告未运行。
    await mkdir(paths.dataDir, { recursive: true });
    await writeFile(join(paths.dataDir, "postmaster.pid"), "123\n");
    const notRunning = Object.assign(new Error("Command failed"), {
      stderr: 'pg_ctl: PID file "x/postmaster.pid" does not exist\nIs server running?\n',
      code: 1,
    });
    await expect(stopPostgres(paths, { run: fakeRunner(calls, notRunning) })).resolves.toBeUndefined();

    const other = Object.assign(new Error("Command failed"), { stderr: "pg_ctl: could not send stop signal", code: 1 });
    await expect(stopPostgres(paths, { run: fakeRunner(calls, other) })).rejects.toThrow("Command failed");
  });

  it("detects free and occupied ports", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(await isPortFree(port)).toBe(true);

    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      expect(await isPortFree(port)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("builds a URL with an encoded password", () => {
    expect(postgresUrl({ port: 5432, password: "a/b@c:d%e" })).toBe(
      "postgres://marvis:a%2Fb%40c%3Ad%25e@127.0.0.1:5432/postgres?sslmode=disable",
    );
  });

  // 指向真实便携包的 bin 目录时才跑：MARVIS_STANDALONE_PG_BIN=/path/to/pg/bin
  const realBin = process.env.MARVIS_STANDALONE_PG_BIN;
  it.skipIf(!realBin)(
    "initializes, starts and stops a real PostgreSQL",
    async () => {
      const real: PostgresPaths = { ...paths, binDir: realBin! };

      expect(await initPostgres(real, { password: "p@ss word" })).toBe(true);
      expect(await initPostgres(real, { password: "p@ss word" })).toBe(false);

      const port = await findFreePort();
      await startPostgres(real, { port });
      try {
        expect(await isPortFree(port)).toBe(false);
        expect(existsSync(join(real.dataDir, "postmaster.pid"))).toBe(true);
      } finally {
        await stopPostgres(real);
      }

      expect(existsSync(join(real.dataDir, "postmaster.pid"))).toBe(false);
      expect(await isPortFree(port)).toBe(true);
      await stopPostgres(real);
    },
    120_000,
  );
});
