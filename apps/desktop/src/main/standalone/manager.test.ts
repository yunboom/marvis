// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  STANDALONE_ERROR_CHECKSUM,
  STANDALONE_ERROR_PORT_IN_USE,
  STANDALONE_ERROR_START_FAILED,
  STANDALONE_ERROR_UNSUPPORTED_PLATFORM,
  defaultStandaloneSettings,
  generateStandaloneSecrets,
  type StandaloneManifest,
  type StandalonePhase,
  type StandaloneSetupInput,
  type StandaloneStatus,
} from "../../shared/standalone";
import { BootstrapLoginError } from "./bootstrap-login";
import { readSecrets, type SecretCodec } from "./config-store";
import { DownloadAbortedError, DownloadChecksumError, type DownloadOptions } from "./download";
import { StandaloneManager, StandaloneValidationError, type StandaloneOps } from "./manager";
import { standaloneLayout } from "./paths";
import type { ServerHandle } from "./server-process";

const codec: SecretCodec = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString("base64")}`),
  decrypt: (data) => Buffer.from(data.toString().slice(4), "base64").toString(),
};

function asset(name: string) {
  return { name, size: 100, sha256: "a".repeat(64), urls: [`https://example.com/${name}`] };
}

function manifest(version = "0.6.6"): StandaloneManifest {
  return {
    schemaVersion: 1,
    version,
    minAppVersion: "0.0.0",
    server: { "darwin-arm64": asset(`marvis-server-${version}-darwin-arm64.tar.xz`) },
    postgres: { version: "17.11.0", assets: { "darwin-arm64": asset("marvis-postgres-17.11.0-darwin-arm64.tar.xz") } },
  };
}

function setupInput(): StandaloneSetupInput {
  const settings = defaultStandaloneSettings("studio");
  settings.adminEmail = "admin@example.com";
  return { settings, secrets: generateStandaloneSecrets() };
}

// 一个可控的服务端进程：exit() 模拟意外退出。
function fakeHandle(): ServerHandle & { exit(code: number): void } {
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((r) => (resolveExit = r));
  return {
    pid: 4242,
    exited,
    stop: vi.fn(async () => resolveExit(0)),
    exit: (code) => resolveExit(code),
  };
}

interface Harness {
  manager: StandaloneManager;
  phases: StandalonePhase[];
  last: () => StandaloneStatus;
  ops: StandaloneOps;
  handles: ReturnType<typeof fakeHandle>[];
  selected: string[];
  tokens: string[];
  root: string;
  setManifest(m: StandaloneManifest): void;
}

let clockTick = 0;

async function harness(overrides: Partial<StandaloneOps> = {}, platformKey: "darwin-arm64" | null = "darwin-arm64"): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "standalone-manager-"));
  const layout = standaloneLayout(root);
  const phases: StandalonePhase[] = [];
  const statuses: StandaloneStatus[] = [];
  const handles: ReturnType<typeof fakeHandle>[] = [];
  const selected: string[] = [];
  const tokens: string[] = [];
  let current = manifest();

  const ops: StandaloneOps = {
    fetchManifest: vi.fn(async () => current),
    download: vi.fn(async (o: DownloadOptions) => {
      o.onProgress?.({ receivedBytes: o.expectedSize, totalBytes: o.expectedSize, bytesPerSecond: 10 });
      await writeFile(o.destPath, "bundle");
    }),
    installArchive: vi.fn(async (_archive: string, finalDir: string) => {
      await mkdir(finalDir, { recursive: true });
    }),
    initPostgres: vi.fn(async (paths) => {
      await mkdir(paths.dataDir, { recursive: true });
      await writeFile(join(paths.dataDir, "PG_VERSION"), "17");
      return true;
    }),
    startPostgres: vi.fn(async () => undefined),
    stopPostgres: vi.fn(async () => undefined),
    findFreePort: vi.fn(async () => 55432),
    isPortFree: vi.fn(async () => true),
    runMigrations: vi.fn(async () => undefined),
    startServerProcess: vi.fn(() => {
      const h = fakeHandle();
      handles.push(h);
      return h;
    }),
    waitForReady: vi.fn(async () => undefined),
    killStaleProcess: vi.fn(async () => false),
    tailFile: vi.fn(async () => "last log lines"),
    bootstrapLogin: vi.fn(async () => "jwt-token"),
    ...overrides,
  };

  const manager = new StandaloneManager({
    layout,
    platformKey,
    appVersion: "0.6.6",
    manifestUrl: "https://example.com/server-manifest.json",
    hostName: "studio",
    baseEnv: { PATH: "/usr/bin" },
    codec,
    publish: (s) => {
      statuses.push(s);
      if (phases[phases.length - 1] !== s.phase) phases.push(s.phase);
    },
    lanAddress: () => "192.168.1.20",
    selectStandaloneServer: async (url) => {
      selected.push(url);
    },
    deliverToken: (t) => tokens.push(t),
    log: () => undefined,
    ops,
    now: () => new Date(Date.UTC(2026, 9, 24, 8, 0, clockTick++)),
  });
  await manager.init();

  return {
    manager,
    phases,
    last: () => statuses[statuses.length - 1],
    ops,
    handles,
    selected,
    tokens,
    root,
    setManifest: (m) => (current = m),
  };
}

async function settle(h: Harness, phase: StandalonePhase): Promise<void> {
  await vi.waitFor(() => expect(h.last().phase).toBe(phase));
}

describe("StandaloneManager install", () => {
  it("downloads, installs and starts", async () => {
    const h = await harness();

    await h.manager.install(setupInput());
    await settle(h, "running");

    expect(h.phases).toEqual(["not_installed", "downloading", "verifying", "installing", "starting", "running"]);
    expect(h.last()).toMatchObject({ version: "0.6.6", localUrl: "http://127.0.0.1:13840", lanUrl: null });
    expect(h.ops.download).toHaveBeenCalledTimes(2);
    expect(existsSync(join(h.root, "downloads"))).toBe(false);
    const state = JSON.parse(await readFile(join(h.root, "config.json"), "utf-8"));
    expect(state).toMatchObject({ locked: true, serverVersion: "0.6.6", postgresVersion: "17.11.0" });
    // 敏感配置加密落盘，状态文件里没有明文密钥。
    expect(JSON.stringify(state)).not.toContain("jwtSecret");
  });

  it("rejects invalid settings without writing anything", async () => {
    const h = await harness();
    const input = setupInput();
    input.settings.adminEmail = "";

    await expect(h.manager.install(input)).rejects.toBeInstanceOf(StandaloneValidationError);
    expect(existsSync(join(h.root, "config.json"))).toBe(false);
  });

  it("reports a busy port with the port number", async () => {
    const h = await harness({ isPortFree: vi.fn(async () => false) });

    await h.manager.install(setupInput());
    await settle(h, "failed");

    expect(h.last().error).toMatchObject({ code: STANDALONE_ERROR_PORT_IN_USE, port: 13840 });
    expect(h.ops.startServerProcess).not.toHaveBeenCalled();
  });

  // 首次启动没成功（未锁定）但数据库已经初始化：重新提交设置不能换掉数据库密码。
  it("keeps the database password once the data directory exists", async () => {
    const h = await harness({ isPortFree: vi.fn(async () => false) });
    await h.manager.install(setupInput());
    await settle(h, "failed");
    const first = await readSecrets(standaloneLayout(h.root).secretsFile, codec);

    await h.manager.install(setupInput());
    await settle(h, "failed");

    const second = await readSecrets(standaloneLayout(h.root).secretsFile, codec);
    expect(second?.postgresPassword).toBe(first?.postgresPassword);
  });

  it("pauses and resumes the download", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const download = vi.fn(async (o: DownloadOptions) => {
      calls++;
      if (o.signal?.aborted) throw new DownloadAbortedError();
      const aborted = new Promise((_, reject) =>
        o.signal?.addEventListener("abort", () => reject(new DownloadAbortedError())),
      );
      if (calls === 1) await aborted;
      await Promise.race([gate, aborted]);
      await writeFile(o.destPath, "bundle");
    });
    const h = await harness({ download });

    await h.manager.install(setupInput());
    await settle(h, "downloading");
    h.manager.pause();
    await settle(h, "paused");

    release();
    h.manager.resume();
    await settle(h, "running");
  });

  it("ignores resume while the download waits for the network", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const download = vi.fn(async (o: DownloadOptions) => {
      o.onWaitingForNetwork?.(true);
      await gate;
      o.onWaitingForNetwork?.(false);
      await writeFile(o.destPath, "bundle");
    });
    const h = await harness({ download });

    await h.manager.install(setupInput());
    await settle(h, "paused");
    h.manager.resume();
    release();
    await settle(h, "running");

    expect(h.ops.fetchManifest).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("aborts the other download and waits for it when one fails", async () => {
    let otherAborted = false;
    const download = vi.fn(async (o: DownloadOptions) => {
      if (o.destPath.includes("server")) throw new DownloadChecksumError("mismatch");
      await new Promise((_, reject) =>
        o.signal?.addEventListener("abort", () => {
          otherAborted = true;
          reject(new DownloadAbortedError());
        }),
      );
    });
    const h = await harness({ download });

    await h.manager.install(setupInput());
    await settle(h, "failed");

    expect(otherAborted).toBe(true);
    expect(h.last().error?.code).toBe(STANDALONE_ERROR_CHECKSUM);
  });

  it("fails with a checksum error", async () => {
    const h = await harness({
      download: vi.fn(async () => {
        throw new DownloadChecksumError("mismatch");
      }),
    });

    await h.manager.install(setupInput());
    await settle(h, "failed");

    expect(h.last().error?.code).toBe(STANDALONE_ERROR_CHECKSUM);
  });

  it("refuses unsupported platforms", async () => {
    const h = await harness({}, null);

    await h.manager.install(setupInput());
    await settle(h, "failed");

    expect(h.last().error?.code).toBe(STANDALONE_ERROR_UNSUPPORTED_PLATFORM);
  });
});

describe("StandaloneManager running", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
    await h.manager.install(setupInput());
    await settle(h, "running");
  });

  it("enters: selects the local server and hands the session token over", async () => {
    await h.manager.enter();

    expect(h.selected).toEqual(["http://127.0.0.1:13840"]);
    expect(h.tokens).toEqual(["jwt-token"]);
    expect(h.ops.bootstrapLogin).toHaveBeenCalledWith("http://127.0.0.1:13840", expect.stringMatching(/^[0-9a-f]{64}$/), "admin@example.com");
  });

  it("restarts for a fresh bootstrap token when the old one was used", async () => {
    await h.manager.enter();
    await h.manager.enter();

    expect(h.handles).toHaveLength(2);
    expect(h.tokens).toEqual(["jwt-token", "jwt-token"]);
  });

  it("restarts when the server reports the token as used", async () => {
    const login = vi.mocked(h.ops.bootstrapLogin);
    login.mockRejectedValueOnce(new BootstrapLoginError("used", true));

    await h.manager.enter();

    expect(h.handles).toHaveLength(2);
    expect(h.tokens).toEqual(["jwt-token"]);
  });

  it("marks an unexpected server exit as failed", async () => {
    h.handles[0].exit(2);
    await settle(h, "failed");

    expect(h.last().error?.code).toBe(STANDALONE_ERROR_START_FAILED);
    expect(h.ops.stopPostgres).toHaveBeenCalled();
  });

  it("stops the server and the database", async () => {
    await h.manager.stop();

    expect(h.last().phase).toBe("stopped");
    expect(h.handles[0].stop).toHaveBeenCalled();
    expect(h.manager.isRunning()).toBe(false);
  });

  it("restarts with LAN access on a changed setting", async () => {
    await h.manager.setLan(true);

    expect(h.handles).toHaveLength(2);
    expect(h.last()).toMatchObject({ phase: "running", lanUrl: "http://192.168.1.20:13840" });
    expect(h.ops.isPortFree).toHaveBeenLastCalledWith(13840, "0.0.0.0");
  });

  it("reselects the local server when the port changes", async () => {
    const edit = setupInput();
    edit.settings.port = 13841;

    await h.manager.saveSettings(edit);

    expect(h.last()).toMatchObject({ phase: "running", localUrl: "http://127.0.0.1:13841" });
    expect(h.selected).toEqual(["http://127.0.0.1:13841"]);
  });

  it("forces the server and database down on quit when the queue is busy", async () => {
    vi.mocked(h.ops.runMigrations).mockImplementationOnce(() => new Promise(() => undefined));
    void h.manager.restart();
    await settle(h, "starting");
    const stopsBefore = vi.mocked(h.ops.stopPostgres).mock.calls.length;

    await h.manager.shutdown(20);

    expect(vi.mocked(h.ops.stopPostgres).mock.calls.length).toBeGreaterThan(stopsBefore);
    expect(h.manager.isRunning()).toBe(false);
  });

  it("saves settings with locked keys and saved secrets left empty", async () => {
    const before = await readSecrets(standaloneLayout(h.root).secretsFile, codec);
    const first = setupInput();
    first.settings.lark.appId = "cli_abc";
    first.secrets.larkAppSecret = "lark-secret";
    await h.manager.saveSettings(first);

    const edit = setupInput();
    edit.settings.lark.appId = "cli_abc";
    edit.settings.name = "studio 2";
    edit.secrets.jwtSecret = "";
    edit.secrets.postgresPassword = "";
    for (const env of Object.keys(edit.secrets.integrationKeys) as (keyof typeof edit.secrets.integrationKeys)[]) {
      edit.secrets.integrationKeys[env] = "";
    }
    await h.manager.saveSettings(edit);

    const after = await readSecrets(standaloneLayout(h.root).secretsFile, codec);
    expect(after).toMatchObject({
      jwtSecret: before?.jwtSecret,
      integrationKeys: before?.integrationKeys,
      postgresPassword: before?.postgresPassword,
      larkAppSecret: "lark-secret",
    });
    expect((await h.manager.configView())?.settings.name).toBe("studio 2");
  });
});

describe("StandaloneManager updates and backups", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
    await h.manager.install(setupInput());
    await settle(h, "running");
    await writeFile(join(h.root, "pgdata", "data.txt"), "before-update");
    await h.manager.setAutoDownloadUpdates(false);
  });

  it("installs a newer version after a backup", async () => {
    h.setManifest(manifest("0.6.7"));

    await h.manager.checkForUpdate();
    expect(h.last().update).toMatchObject({ state: "available", availableVersion: "0.6.7" });

    await h.manager.installUpdate();

    expect(h.last()).toMatchObject({ phase: "running", version: "0.6.7", update: { state: "latest" } });
    const backups = await h.manager.listBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ version: "0.6.6", reason: "update" });
    const state = JSON.parse(await readFile(join(h.root, "config.json"), "utf-8"));
    expect(state).toMatchObject({ serverVersion: "0.6.7", previousServerVersion: "0.6.6" });
  });

  it("rolls back to the previous version and data when the new one fails", async () => {
    h.setManifest(manifest("0.6.7"));
    await h.manager.checkForUpdate();
    vi.mocked(h.ops.runMigrations).mockImplementationOnce(async () => {
      await writeFile(join(h.root, "pgdata", "data.txt"), "half-migrated");
      throw new Error("migration 591 failed");
    });

    await h.manager.installUpdate();

    expect(h.last()).toMatchObject({ phase: "running", version: "0.6.6", update: { state: "rolled_back" } });
    expect(await readFile(join(h.root, "pgdata", "data.txt"), "utf-8")).toBe("before-update");
  });

  it("keeps the old version running when the backup before an update fails", async () => {
    h.setManifest(manifest("0.6.7"));
    await h.manager.checkForUpdate();
    vi.mocked(h.ops.stopPostgres).mockRejectedValueOnce(new Error("pg_ctl stop timed out"));

    await expect(h.manager.installUpdate()).rejects.toThrow(/timed out/);

    expect(h.last()).toMatchObject({ phase: "running", version: "0.6.6", update: { state: "available" } });
    expect(await h.manager.listBackups()).toHaveLength(0);
  });

  it("puts the original data back after a restore was interrupted", async () => {
    await h.manager.stop();
    await rename(join(h.root, "pgdata"), join(h.root, "pgdata.before-restore"));
    await mkdir(join(h.root, "pgdata.restoring"), { recursive: true });

    await h.manager.init();

    expect(await readFile(join(h.root, "pgdata", "data.txt"), "utf-8")).toBe("before-update");
    expect(existsSync(join(h.root, "pgdata.before-restore"))).toBe(false);
    expect(existsSync(join(h.root, "pgdata.restoring"))).toBe(false);
  });

  it("stays latest when the manifest is not newer", async () => {
    await h.manager.checkForUpdate();

    expect(h.last().update.state).toBe("latest");
  });

  it("keeps the three newest backups", async () => {
    for (let i = 0; i < 4; i++) {
      await h.manager.backupNow();
    }

    expect(await h.manager.listBackups()).toHaveLength(3);
    expect(h.last().phase).toBe("running");
  });

  it("restores a backup", async () => {
    await h.manager.backupNow();
    const [backup] = await h.manager.listBackups();
    await writeFile(join(h.root, "pgdata", "data.txt"), "changed");

    await h.manager.restoreBackup(backup.fileName);

    expect(await readFile(join(h.root, "pgdata", "data.txt"), "utf-8")).toBe("before-update");
    expect(h.last().phase).toBe("running");
  });
});
