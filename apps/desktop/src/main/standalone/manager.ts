import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm, stat, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  STANDALONE_ERROR_CHECKSUM,
  STANDALONE_ERROR_DISK,
  STANDALONE_ERROR_MANIFEST,
  STANDALONE_ERROR_NETWORK,
  STANDALONE_ERROR_PORT_IN_USE,
  STANDALONE_ERROR_START_FAILED,
  STANDALONE_ERROR_UNSUPPORTED_PLATFORM,
  STANDALONE_PHASE_DOWNLOADING,
  STANDALONE_PHASE_FAILED,
  STANDALONE_PHASE_INSTALLING,
  STANDALONE_PHASE_NOT_INSTALLED,
  STANDALONE_PHASE_PAUSED,
  STANDALONE_PHASE_RUNNING,
  STANDALONE_PHASE_STARTING,
  STANDALONE_PHASE_STOPPED,
  STANDALONE_PHASE_VERIFYING,
  STANDALONE_UPDATE_AVAILABLE,
  STANDALONE_UPDATE_DOWNLOADING,
  STANDALONE_UPDATE_INSTALLING,
  STANDALONE_UPDATE_LATEST,
  STANDALONE_UPDATE_ROLLED_BACK,
  defaultStandaloneSettings,
  generateStandaloneSecrets,
  randomHexSecret,
  validateStandaloneSetup,
  type StandaloneAsset,
  type StandaloneBackup,
  type StandaloneConfigView,
  type StandaloneError,
  type StandaloneErrorCode,
  type StandaloneManifest,
  type StandalonePhase,
  type StandalonePlatformKey,
  type StandaloneProgress,
  type StandaloneSecrets,
  type StandaloneSetupInput,
  type StandaloneStatus,
  type StandaloneUpdateStatus,
  type ValidationErrors,
} from "../../shared/standalone";
import { BootstrapLoginError, bootstrapLogin } from "./bootstrap-login";
import {
  mergeSecrets,
  readSecrets,
  readStateFile,
  writeSecrets,
  writeStateFile,
  type SecretCodec,
  type StandaloneStateFile,
} from "./config-store";
import { DownloadAbortedError, DownloadChecksumError, DownloadNetworkError, downloadResumable } from "./download";
import { buildMigrateEnv, buildServerEnv } from "./env";
import { installArchive } from "./extract";
import { ManifestError, compareVersions, fetchManifest } from "./manifest";
import type { StandaloneLayout } from "./paths";
import { findFreePort, initPostgres, isPortFree, postgresUrl, startPostgres, stopPostgres } from "./postgres";
import {
  killStaleProcess,
  runMigrations,
  startServerProcess,
  tailFile,
  waitForReady,
  type ServerHandle,
} from "./server-process";

// 总进度的权重：下载 85%、校验 5%、安装 10%（见设计稿 40）。
const DOWNLOAD_WEIGHT = 85;
const VERIFY_DONE = 90;
const EXTRACT_DONE = 95;
const INSTALL_DONE = 100;

// 保留的备份份数。
const MAX_BACKUPS = 3;
// 备份目录里的元信息文件。
const BACKUP_META = "backup.json";
const BACKUP_DATA = "pgdata";
const BACKUP_REASON_UPDATE = "update";
const BACKUP_REASON_MANUAL = "manual";
type BackupReason = typeof BACKUP_REASON_UPDATE | typeof BACKUP_REASON_MANUAL;

// initdb 完成后数据目录里一定有的文件。
const PG_VERSION_FILE = "PG_VERSION";

const LOOPBACK = "127.0.0.1";
const ALL_INTERFACES = "0.0.0.0";

// 单机模式可替换的外部操作，测试注入假实现。
export interface StandaloneOps {
  fetchManifest: typeof fetchManifest;
  download: typeof downloadResumable;
  installArchive: typeof installArchive;
  initPostgres: typeof initPostgres;
  startPostgres: typeof startPostgres;
  stopPostgres: typeof stopPostgres;
  findFreePort: typeof findFreePort;
  isPortFree: typeof isPortFree;
  runMigrations: typeof runMigrations;
  startServerProcess: typeof startServerProcess;
  waitForReady: typeof waitForReady;
  killStaleProcess: typeof killStaleProcess;
  tailFile: typeof tailFile;
  bootstrapLogin: typeof bootstrapLogin;
}

const DEFAULT_OPS: StandaloneOps = {
  fetchManifest,
  download: downloadResumable,
  installArchive,
  initPostgres,
  startPostgres,
  stopPostgres,
  findFreePort,
  isPortFree,
  runMigrations,
  startServerProcess,
  waitForReady,
  killStaleProcess,
  tailFile,
  bootstrapLogin,
};

export interface StandaloneManagerDeps {
  layout: StandaloneLayout;
  platformKey: StandalonePlatformKey | null;
  appVersion: string;
  manifestUrl: string;
  hostName: string;
  baseEnv: NodeJS.ProcessEnv;
  codec: SecretCodec;
  // 推送最新状态给界面。
  publish(status: StandaloneStatus): void;
  // 本机局域网 IPv4，没有时返回 null。
  lanAddress(): string | null;
  // 选定本机服务器：写 server.json（来源 standalone）、更新运行配置并重载窗口。
  selectStandaloneServer(localUrl: string, name: string): Promise<void>;
  // 把登录凭证交给界面（经 auth:token 队列）。
  deliverToken(token: string): void;
  log(message: string, extra?: Record<string, unknown>): void;
  ops?: Partial<StandaloneOps>;
  now?: () => Date;
}

// 设置校验不通过；errors 交给界面逐项显示。
export class StandaloneValidationError extends Error {
  constructor(readonly errors: ValidationErrors) {
    super("standalone settings are invalid");
  }
}

class StandaloneOperationError extends Error {
  constructor(
    readonly code: StandaloneErrorCode,
    message: string,
    readonly port?: number,
  ) {
    super(message);
  }
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDiskError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOSPC" || code === "EDQUOT" || code === "EROFS" || code === "EACCES" || code === "EPERM";
}

// 把安装、启动中的异常归到界面能理解的错误码。
function toStandaloneError(err: unknown): StandaloneError {
  if (err instanceof StandaloneOperationError) return { code: err.code, detail: err.message, port: err.port };
  if (err instanceof DownloadChecksumError) return { code: STANDALONE_ERROR_CHECKSUM, detail: err.message };
  if (err instanceof DownloadNetworkError) return { code: STANDALONE_ERROR_NETWORK, detail: err.message };
  if (err instanceof ManifestError) return { code: STANDALONE_ERROR_MANIFEST, detail: err.message };
  if (isDiskError(err)) return { code: STANDALONE_ERROR_DISK, detail: errorDetail(err) };
  return { code: STANDALONE_ERROR_START_FAILED, detail: errorDetail(err) };
}

function latestUpdate(): StandaloneUpdateStatus {
  return { state: STANDALONE_UPDATE_LATEST, availableVersion: null, sizeBytes: null, progress: null, checkedAt: null };
}

// 把多个并发下载的字节数合成一条进度。
class ProgressTracker {
  private readonly received = new Map<string, number>();
  private readonly speeds = new Map<string, number>();

  constructor(
    private readonly totalBytes: number,
    private readonly onChange: (p: StandaloneProgress) => void,
  ) {}

  update(key: string, receivedBytes: number, bytesPerSecond: number): void {
    this.received.set(key, receivedBytes);
    this.speeds.set(key, bytesPerSecond);
    this.onChange(this.snapshot());
  }

  snapshot(): StandaloneProgress {
    const received = [...this.received.values()].reduce((a, b) => a + b, 0);
    const speed = [...this.speeds.values()].reduce((a, b) => a + b, 0);
    const remaining = Math.max(0, this.totalBytes - received);
    return {
      percent: this.totalBytes > 0 ? Math.floor((received / this.totalBytes) * DOWNLOAD_WEIGHT) : 0,
      receivedBytes: received,
      totalBytes: this.totalBytes,
      bytesPerSecond: speed,
      etaSeconds: speed > 0 ? Math.ceil(remaining / speed) : null,
    };
  }
}

interface RunningServer {
  handle: ServerHandle;
  bootstrapToken: string;
  bootstrapUsed: boolean;
  localUrl: string;
}

// 单机模式的编排：安装、启停、进入、资源更新、备份与切换。所有修改状态的操作串行执行。
export class StandaloneManager {
  private readonly ops: StandaloneOps;
  private readonly now: () => Date;
  private state: StandaloneStateFile | null = null;
  private current: StandaloneStatus;
  private queue: Promise<unknown> = Promise.resolve();
  private installAbort: AbortController | null = null;
  private userPaused = false;
  private running: RunningServer | null = null;
  private stopping = false;
  private pendingManifest: StandaloneManifest | null = null;
  private updateDownloaded = false;
  private updateAbort: AbortController | null = null;
  // 启动中、尚未就绪的服务端进程：退出时也要能停掉。
  private startingHandle: ServerHandle | null = null;
  private shuttingDown = false;

  constructor(private readonly deps: StandaloneManagerDeps) {
    this.ops = { ...DEFAULT_OPS, ...deps.ops };
    this.now = deps.now ?? (() => new Date());
    this.current = {
      phase: STANDALONE_PHASE_NOT_INSTALLED,
      version: null,
      progress: null,
      error: null,
      lanUrl: null,
      localUrl: null,
      startedAt: null,
      update: latestUpdate(),
    };
  }

  // ---------- 状态 ----------

  status(): StandaloneStatus {
    return this.current;
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  // 设置过单机模式：本机可能有服务端或数据库进程需要随 App 退出。
  hasLocalResources(): boolean {
    return this.state !== null;
  }

  isInstalled(): boolean {
    return Boolean(this.state?.serverVersion && this.state.postgresVersion);
  }

  private set(patch: Partial<StandaloneStatus>): void {
    this.current = { ...this.current, ...patch };
    this.deps.publish(this.current);
  }

  private setPhase(phase: StandalonePhase, patch: Partial<StandaloneStatus> = {}): void {
    this.set({ phase, ...patch });
  }

  private setUpdate(patch: Partial<StandaloneUpdateStatus>): void {
    this.set({ update: { ...this.current.update, ...patch } });
  }

  // 串行执行会改变状态的操作，避免安装、启停、更新互相踩踏。
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // 读取状态文件，决定初始阶段。应用启动时调用一次。
  async init(): Promise<void> {
    await this.recoverInterruptedRestore();
    this.state = await readStateFile(this.deps.layout.stateFile);
    if (this.isInstalled()) {
      this.setPhase(STANDALONE_PHASE_STOPPED, { version: this.state?.serverVersion ?? null });
    } else if (existsSync(this.deps.layout.downloadsDir) && this.state) {
      // 上次下载到一半就退出了：保留进度，等用户在准备资源页继续。
      this.setPhase(STANDALONE_PHASE_PAUSED);
    } else {
      this.setPhase(STANDALONE_PHASE_NOT_INSTALLED);
    }
  }

  // 「完成设置」页的预填值：已保存的设置，或按主机名生成的默认值；密钥总是新生成。
  defaults(): StandaloneSetupInput {
    return {
      settings: this.state?.settings ?? defaultStandaloneSettings(this.deps.hostName),
      secrets: generateStandaloneSecrets(),
    };
  }

  async configView(): Promise<StandaloneConfigView | null> {
    if (!this.state) return null;
    const secrets = await readSecrets(this.deps.layout.secretsFile, this.deps.codec);
    return {
      settings: this.state.settings,
      locked: this.state.locked,
      loginCode: secrets?.loginCode ?? "",
      hasLarkAppSecret: Boolean(secrets?.larkAppSecret),
      hasSmtpPassword: Boolean(secrets?.smtpPassword),
      hasLlmApiKey: Boolean(secrets?.llmApiKey),
    };
  }

  autoDownloadUpdates(): boolean {
    return this.state?.autoDownloadUpdates ?? true;
  }

  // 「打开」数据目录与「日志」用到的路径。
  dataRoot(): string {
    return this.deps.layout.root;
  }

  logsDir(): string {
    return this.deps.layout.logsDir;
  }

  // ---------- 配置 ----------

  // 校验并保存配置；锁定后的密钥沿用已保存的值。
  private async persistSetup(input: StandaloneSetupInput): Promise<void> {
    const locked = this.state?.locked ?? false;
    const existing = await readSecrets(this.deps.layout.secretsFile, this.deps.codec);
    const secrets = mergeSecrets(existing, input.secrets, locked, input.settings);
    // 数据库一旦初始化，密码就写进了数据目录：无论是否锁定都沿用已保存的密码。
    if (existing?.postgresPassword && existsSync(join(this.deps.layout.pgData, PG_VERSION_FILE))) {
      secrets.postgresPassword = existing.postgresPassword;
    }

    // 校验合并后的结果：设置页拿不到已锁定的密钥和已保存的可选密钥，提交 "" 表示不变。
    const errors = validateStandaloneSetup({ settings: input.settings, secrets });
    if (Object.keys(errors).length > 0) throw new StandaloneValidationError(errors);

    await writeSecrets(this.deps.layout.secretsFile, secrets, this.deps.codec);

    this.state = {
      settings: input.settings,
      locked,
      serverVersion: this.state?.serverVersion ?? null,
      previousServerVersion: this.state?.previousServerVersion ?? null,
      postgresVersion: this.state?.postgresVersion ?? null,
      installedAt: this.state?.installedAt ?? null,
      autoDownloadUpdates: this.state?.autoDownloadUpdates ?? true,
    };
    await this.saveState();
  }

  private async saveState(): Promise<void> {
    if (this.state) await writeStateFile(this.deps.layout.stateFile, this.state);
  }

  private async loadSecrets(): Promise<StandaloneSecrets> {
    const secrets = await readSecrets(this.deps.layout.secretsFile, this.deps.codec);
    if (!secrets) throw new StandaloneOperationError(STANDALONE_ERROR_START_FAILED, "standalone secrets are missing");
    return secrets;
  }

  // 「设置」页保存配置：校验、保存，运行中则重启生效。
  saveSettings(input: StandaloneSetupInput): Promise<void> {
    return this.serial(async () => {
      const previousPort = this.state?.settings.port;
      await this.persistSetup(input);
      if (!this.running) return;

      await this.stopInternal();
      await this.startInternal();
      // 端口变了：客户端还连着旧地址，重新选定本机服务器。
      const running = this.running as RunningServer | null;
      if (running && previousPort !== input.settings.port) {
        await this.deps.selectStandaloneServer(running.localUrl, input.settings.name);
      }
    });
  }

  // 「允许局域网连接」开关：改设置并在运行中重启。
  setLan(enabled: boolean): Promise<void> {
    return this.serial(async () => {
      if (!this.state) return;
      this.state = { ...this.state, settings: { ...this.state.settings, lanEnabled: enabled } };
      await this.saveState();
      if (this.running) {
        await this.stopInternal();
        await this.startInternal();
      }
    });
  }

  setAutoDownloadUpdates(enabled: boolean): Promise<void> {
    return this.serial(async () => {
      if (!this.state) return;
      this.state = { ...this.state, autoDownloadUpdates: enabled };
      await this.saveState();
    });
  }

  // ---------- 安装 ----------

  // 「下载资源」：校验并保存配置，然后在后台下载、安装、启动。返回时安装已开始。
  async install(input: StandaloneSetupInput): Promise<void> {
    await this.serial(() => this.persistSetup(input));
    void this.runInstall();
  }

  // 继续下载（暂停后或上次退出时下到一半）。
  resume(): void {
    // 断网等待时也显示「已暂停」，但安装仍在进行，网络恢复后自动续传，不再排一次安装。
    if (this.installAbort) return;
    if (this.current.phase === STANDALONE_PHASE_PAUSED || this.current.phase === STANDALONE_PHASE_FAILED) {
      void this.runInstall();
    }
  }

  pause(): void {
    if (!this.installAbort) return;
    this.userPaused = true;
    this.installAbort.abort();
  }

  // 取消准备：中止下载并删掉下载了一半的文件。
  async cancel(): Promise<void> {
    this.userPaused = false;
    this.installAbort?.abort();
    await this.serial(async () => {
      await rm(this.deps.layout.downloadsDir, { recursive: true, force: true });
      this.setPhase(this.isInstalled() ? STANDALONE_PHASE_STOPPED : STANDALONE_PHASE_NOT_INSTALLED, {
        progress: null,
        error: null,
      });
    });
  }

  // 失败后重试：安装未完成就重新准备资源，否则重新启动。
  retry(): Promise<void> {
    if (!this.isInstalled()) {
      void this.runInstall();
      return Promise.resolve();
    }
    return this.start();
  }

  private runInstall(): Promise<void> {
    return this.serial(async () => {
      if (this.shuttingDown) return;
      const platform = this.deps.platformKey;
      if (!platform) {
        this.setPhase(STANDALONE_PHASE_FAILED, {
          error: { code: STANDALONE_ERROR_UNSUPPORTED_PLATFORM },
          progress: null,
        });
        return;
      }

      const abort = new AbortController();
      this.installAbort = abort;
      this.userPaused = false;
      this.setPhase(STANDALONE_PHASE_DOWNLOADING, { error: null, progress: this.current.progress });

      try {
        const manifest = await this.ops.fetchManifest(this.deps.manifestUrl, undefined, abort.signal);
        if (abort.signal.aborted) throw new DownloadAbortedError();
        this.assertAppSupported(manifest);
        const serverAsset = manifest.server[platform];
        const postgresAsset = manifest.postgres.assets[platform];
        if (!serverAsset || !postgresAsset) {
          throw new StandaloneOperationError(STANDALONE_ERROR_UNSUPPORTED_PLATFORM, `no bundles for ${platform}`);
        }

        const needPostgres = !this.postgresReady(manifest.postgres.version);
        const needServer = !this.serverReady(manifest.version);
        const assets = [
          ...(needServer ? [serverAsset] : []),
          ...(needPostgres ? [postgresAsset] : []),
        ];
        await this.downloadAssets(assets, abort.signal, (progress) =>
          this.set({
            phase: this.current.phase === STANDALONE_PHASE_PAUSED ? STANDALONE_PHASE_PAUSED : STANDALONE_PHASE_DOWNLOADING,
            progress,
          }),
        );

        this.setPhase(STANDALONE_PHASE_VERIFYING, { progress: this.withPercent(VERIFY_DONE) });
        this.setPhase(STANDALONE_PHASE_INSTALLING, { progress: this.withPercent(VERIFY_DONE) });
        if (needPostgres) {
          await this.ops.installArchive(this.deps.layout.download(postgresAsset.name), this.deps.layout.postgresDir(manifest.postgres.version));
        }
        if (needServer) {
          await this.ops.installArchive(this.deps.layout.download(serverAsset.name), this.deps.layout.serverDir(manifest.version));
        }
        this.set({ progress: this.withPercent(EXTRACT_DONE) });

        const state = this.requireState();
        state.postgresVersion = manifest.postgres.version;
        state.serverVersion = manifest.version;
        await this.saveState();
        await rm(this.deps.layout.downloadsDir, { recursive: true, force: true });

        const secrets = await this.loadSecrets();
        await this.ops.initPostgres(this.postgresPaths(), { password: secrets.postgresPassword });
        this.set({ progress: this.withPercent(INSTALL_DONE), version: manifest.version });
      } catch (err) {
        this.installAbort = null;
        if (err instanceof DownloadAbortedError || abort.signal.aborted) {
          if (this.userPaused) this.setPhase(STANDALONE_PHASE_PAUSED);
          return;
        }
        this.deps.log("standalone install failed", { error: errorDetail(err) });
        this.setPhase(STANDALONE_PHASE_FAILED, { error: toStandaloneError(err) });
        return;
      }
      this.installAbort = null;

      // 启动失败时 startInternal 已把状态设为失败并带上原因，这里不再上抛。
      await this.startInternal().catch(() => undefined);
    });
  }

  private assertAppSupported(manifest: StandaloneManifest): void {
    if (compareVersions(this.deps.appVersion, manifest.minAppVersion) < 0) {
      throw new ManifestError(`app ${this.deps.appVersion} is older than ${manifest.minAppVersion}`);
    }
  }

  private postgresReady(version: string): boolean {
    return this.state?.postgresVersion === version && existsSync(this.deps.layout.postgresDir(version));
  }

  private serverReady(version: string): boolean {
    return this.state?.serverVersion === version && existsSync(this.deps.layout.serverDir(version));
  }

  private withPercent(percent: number): StandaloneProgress {
    const p = this.current.progress;
    return {
      percent,
      receivedBytes: p?.receivedBytes ?? 0,
      totalBytes: p?.totalBytes ?? 0,
      bytesPerSecond: 0,
      etaSeconds: null,
    };
  }

  private async downloadAssets(
    assets: StandaloneAsset[],
    signal: AbortSignal,
    onProgress: (p: StandaloneProgress) => void,
  ): Promise<void> {
    await mkdir(this.deps.layout.downloadsDir, { recursive: true });
    const tracker = new ProgressTracker(
      assets.reduce((sum, a) => sum + a.size, 0),
      onProgress,
    );

    // 一个下载失败就中止其余的，并等它们都结束：否则重试时会有两个写入者同时追加同一个 .part 文件。
    const local = new AbortController();
    const forwardAbort = () => local.abort();
    signal.addEventListener("abort", forwardAbort, { once: true });
    if (signal.aborted) local.abort();
    let firstError: unknown = null;
    try {
      await Promise.allSettled(
        assets.map((asset) =>
          this.ops
            .download({
              urls: asset.urls,
              destPath: this.deps.layout.download(asset.name),
              expectedSize: asset.size,
              sha256: asset.sha256,
              signal: local.signal,
              onProgress: (p) => tracker.update(asset.name, p.receivedBytes, p.bytesPerSecond),
              // 断网时显示「已暂停」，网络恢复后下载器自动续传。
              onWaitingForNetwork: (waiting) =>
                this.set({ phase: waiting ? STANDALONE_PHASE_PAUSED : STANDALONE_PHASE_DOWNLOADING }),
            })
            .catch((err: unknown) => {
              firstError ??= err;
              local.abort();
            }),
        ),
      );
    } finally {
      signal.removeEventListener("abort", forwardAbort);
    }

    if (firstError !== null) throw firstError;
  }

  // 服务端可能在等待期间意外退出（watchExit 不排队），这时给出可读的错误。
  private requireRunning(): RunningServer {
    if (!this.running) throw new StandaloneOperationError(STANDALONE_ERROR_START_FAILED, "standalone server is not running");
    return this.running;
  }

  private requireState(): StandaloneStateFile {
    if (!this.state) throw new StandaloneOperationError(STANDALONE_ERROR_START_FAILED, "standalone settings are missing");
    return this.state;
  }

  private postgresPaths() {
    const state = this.requireState();
    return {
      binDir: join(this.deps.layout.postgresDir(state.postgresVersion ?? ""), "bin"),
      dataDir: this.deps.layout.pgData,
      logFile: this.deps.layout.postgresLog,
    };
  }

  private serverPaths(version?: string) {
    const state = this.requireState();
    return {
      dir: this.deps.layout.serverDir(version ?? state.serverVersion ?? ""),
      logFile: this.deps.layout.serverLog,
      pidFile: this.deps.layout.serverPidFile,
    };
  }

  // ---------- 启停 ----------

  start(): Promise<void> {
    return this.serial(() => this.startInternal());
  }

  stop(): Promise<void> {
    return this.serial(() => this.stopInternal());
  }

  restart(): Promise<void> {
    return this.serial(async () => {
      await this.stopInternal();
      await this.startInternal();
    });
  }

  private async startInternal(): Promise<void> {
    if (this.running) return;
    const state = this.requireState();
    if (!this.isInstalled()) {
      this.setPhase(STANDALONE_PHASE_NOT_INSTALLED);
      return;
    }

    this.setPhase(STANDALONE_PHASE_STARTING, { error: null, progress: null });
    await mkdir(this.deps.layout.logsDir, { recursive: true });
    await mkdir(this.deps.layout.runDir, { recursive: true });
    await mkdir(this.deps.layout.uploadsDir, { recursive: true });

    let handle: ServerHandle | null = null;
    let postgresStarted = false;
    try {
      // 上次异常退出留下的进程先清掉，再从干净的状态启动。
      await this.ops.killStaleProcess(this.deps.layout.serverPidFile);
      await this.ops.stopPostgres(this.postgresPaths()).catch(() => undefined);

      const { settings } = state;
      const host = settings.lanEnabled ? ALL_INTERFACES : LOOPBACK;
      if (!(await this.ops.isPortFree(settings.port, host))) {
        throw new StandaloneOperationError(STANDALONE_ERROR_PORT_IN_USE, `port ${settings.port} is in use`, settings.port);
      }

      const secrets = await this.loadSecrets();
      await this.ops.initPostgres(this.postgresPaths(), { password: secrets.postgresPassword });
      const pgPort = await this.ops.findFreePort(LOOPBACK);
      await this.ops.startPostgres(this.postgresPaths(), { port: pgPort });
      postgresStarted = true;
      const databaseUrl = postgresUrl({ port: pgPort, password: secrets.postgresPassword });

      await this.ops.runMigrations(this.serverPaths(), buildMigrateEnv(databaseUrl, this.deps.baseEnv));

      const bootstrapToken = randomHexSecret();
      const env = buildServerEnv({
        settings,
        secrets,
        databaseUrl,
        uploadsDir: this.deps.layout.uploadsDir,
        bootstrapToken,
        baseEnv: this.deps.baseEnv,
      });
      const localUrl = `http://${LOOPBACK}:${settings.port}`;
      handle = this.ops.startServerProcess(this.serverPaths(), env);
      this.startingHandle = handle;
      await this.ops.waitForReady(localUrl, { exited: handle.exited });

      this.startingHandle = null;
      this.running = { handle, bootstrapToken, bootstrapUsed: false, localUrl };
      this.watchExit(handle);

      if (!state.locked) {
        state.locked = true;
        state.installedAt = this.now().toISOString();
        await this.saveState();
      }

      const lanIp = settings.lanEnabled ? this.deps.lanAddress() : null;
      this.setPhase(STANDALONE_PHASE_RUNNING, {
        version: state.serverVersion,
        localUrl,
        lanUrl: lanIp ? `http://${lanIp}:${settings.port}` : null,
        startedAt: this.now().toISOString(),
        error: null,
      });
    } catch (err) {
      this.deps.log("standalone start failed", { error: errorDetail(err) });
      this.startingHandle = null;
      if (handle) await handle.stop().catch(() => undefined);
      if (postgresStarted) await this.ops.stopPostgres(this.postgresPaths()).catch(() => undefined);
      this.running = null;
      const error = toStandaloneError(err);
      if (error.code === STANDALONE_ERROR_START_FAILED) {
        error.detail = `${error.detail ?? ""}\n${await this.ops.tailFile(this.deps.layout.serverLog).catch(() => "")}`.trim();
      }
      this.setPhase(STANDALONE_PHASE_FAILED, { error, localUrl: null, lanUrl: null, startedAt: null });
      throw err;
    }
  }

  // 运行中服务端意外退出：停掉数据库，显示失败。
  private watchExit(handle: ServerHandle): void {
    void handle.exited.then(async (code) => {
      if (this.stopping || this.running?.handle !== handle) return;
      this.running = null;
      this.deps.log("standalone server exited unexpectedly", { code });
      await this.ops.stopPostgres(this.postgresPaths()).catch(() => undefined);
      this.setPhase(STANDALONE_PHASE_FAILED, {
        error: { code: STANDALONE_ERROR_START_FAILED, detail: `server exited with code ${code}` },
        localUrl: null,
        lanUrl: null,
        startedAt: null,
      });
    });
  }

  // strict：要动数据目录（备份、恢复、更新）时，数据库停不下来必须报错，不能在运行中的数据上操作。
  private async stopInternal(opts: { strict?: boolean } = {}): Promise<void> {
    this.stopping = true;
    try {
      const running = this.running;
      this.running = null;
      if (running) await running.handle.stop();
      if (this.state?.postgresVersion) {
        const stopped = this.ops.stopPostgres(this.postgresPaths());
        if (opts.strict) await stopped;
        else await stopped.catch(() => undefined);
      }
      if (this.isInstalled()) {
        this.setPhase(STANDALONE_PHASE_STOPPED, { localUrl: null, lanUrl: null, startedAt: null });
      }
    } finally {
      this.stopping = false;
    }
  }

  // ---------- 进入 ----------

  // 「进入 Marvis」或登录页「以管理员身份进入」：选定本机服务器并用一次性 token 登录管理员。
  // token 已用过时重启服务端换一个新 token（局域网里的人会断开几秒后自动重连）。
  enter(): Promise<void> {
    return this.serial(async () => {
      if (!this.running) await this.startInternal();
      const state = this.requireState();
      await this.deps.selectStandaloneServer(this.requireRunning().localUrl, state.settings.name);

      if (this.requireRunning().bootstrapUsed) {
        await this.stopInternal();
        await this.startInternal();
      }
      const running = this.requireRunning();
      let token: string;
      try {
        token = await this.ops.bootstrapLogin(running.localUrl, running.bootstrapToken, state.settings.adminEmail);
      } catch (err) {
        if (!(err instanceof BootstrapLoginError) || !err.tokenUsed) throw err;
        await this.stopInternal();
        await this.startInternal();
        const fresh = this.requireRunning();
        token = await this.ops.bootstrapLogin(fresh.localUrl, fresh.bootstrapToken, state.settings.adminEmail);
        fresh.bootstrapUsed = true;
        this.deps.deliverToken(token);
        return;
      }
      running.bootstrapUsed = true;
      this.deps.deliverToken(token);
    });
  }

  // ---------- 资源更新 ----------

  // 检查是否有新的资源版本；有且开启了自动下载时在后台下载。
  checkForUpdate(): Promise<void> {
    return this.serial(async () => {
      const platform = this.deps.platformKey;
      if (!platform || !this.isInstalled()) return;
      let manifest: StandaloneManifest;
      try {
        manifest = await this.ops.fetchManifest(this.deps.manifestUrl);
      } catch (err) {
        this.deps.log("standalone update check failed", { error: errorDetail(err) });
        return;
      }
      const checkedAt = this.now().toISOString();
      const state = this.requireState();
      const newer = compareVersions(manifest.version, state.serverVersion ?? "0.0.0") > 0;
      const supported = compareVersions(this.deps.appVersion, manifest.minAppVersion) >= 0;
      const asset = manifest.server[platform];
      if (!newer || !supported || !asset) {
        this.pendingManifest = null;
        this.setUpdate({ state: STANDALONE_UPDATE_LATEST, availableVersion: null, sizeBytes: null, progress: null, checkedAt });
        return;
      }
      this.pendingManifest = manifest;
      this.updateDownloaded = false;
      this.setUpdate({
        state: STANDALONE_UPDATE_AVAILABLE,
        availableVersion: manifest.version,
        sizeBytes: asset.size,
        progress: null,
        checkedAt,
      });
    }).then(() => {
      if (this.pendingManifest && this.autoDownloadUpdates()) void this.downloadUpdate();
    });
  }

  // 只下载新版本资源，不安装。
  downloadUpdate(): Promise<void> {
    return this.serial(async () => {
      const manifest = this.pendingManifest;
      const platform = this.deps.platformKey;
      if (!manifest || !platform || this.updateDownloaded) return;
      const asset = manifest.server[platform];
      if (!asset) return;
      if (this.shuttingDown) return;
      this.setUpdate({ state: STANDALONE_UPDATE_DOWNLOADING });
      const abort = new AbortController();
      this.updateAbort = abort;
      try {
        await this.downloadAssets([asset], abort.signal, (progress) =>
          this.setUpdate({ progress: { ...progress, percent: Math.round((progress.percent / DOWNLOAD_WEIGHT) * 100) } }),
        );
        this.updateDownloaded = true;
        this.setUpdate({ state: STANDALONE_UPDATE_AVAILABLE, progress: null });
      } catch (err) {
        this.deps.log("standalone update download failed", { error: errorDetail(err) });
        this.setUpdate({ state: STANDALONE_UPDATE_AVAILABLE, progress: null });
      } finally {
        this.updateAbort = null;
      }
    });
  }

  // 安装更新：备份数据 → 安装新资源 → 用新版本启动（执行迁移）；失败时换回旧版本并恢复备份。
  installUpdate(): Promise<void> {
    return this.downloadUpdate().then(() =>
      this.serial(async () => {
        const manifest = this.pendingManifest;
        const platform = this.deps.platformKey;
        const asset = manifest && platform ? manifest.server[platform] : undefined;
        if (!manifest || !asset || !this.updateDownloaded) return;
        const state = this.requireState();
        const previous = state.serverVersion;
        const wasRunning = this.running !== null;

        this.setUpdate({ state: STANDALONE_UPDATE_INSTALLING, progress: null });
        let backup: string;
        try {
          await this.stopInternal({ strict: true });
          backup = await this.createBackup(previous ?? "unknown", BACKUP_REASON_UPDATE);
        } catch (err) {
          // 备份不成功就不更新：保持旧版本，按原状态恢复运行。
          this.deps.log("standalone update backup failed", { error: errorDetail(err) });
          this.setUpdate({ state: STANDALONE_UPDATE_AVAILABLE, progress: null });
          if (wasRunning) await this.startInternal().catch(() => undefined);
          throw err;
        }

        try {
          await this.ops.installArchive(this.deps.layout.download(asset.name), this.deps.layout.serverDir(manifest.version));
          state.previousServerVersion = previous;
          state.serverVersion = manifest.version;
          await this.saveState();
          await this.startInternal();
          await rm(this.deps.layout.downloadsDir, { recursive: true, force: true });
          await this.pruneOldVersions();
          this.pendingManifest = null;
          this.updateDownloaded = false;
          this.setUpdate({
            state: STANDALONE_UPDATE_LATEST,
            availableVersion: null,
            sizeBytes: null,
            progress: null,
          });
          if (!wasRunning) await this.stopInternal();
        } catch (err) {
          this.deps.log("standalone update failed, rolling back", { error: errorDetail(err) });
          try {
            await this.stopInternal({ strict: true });
            state.serverVersion = previous;
            state.previousServerVersion = null;
            await this.saveState();
            await this.restoreBackupData(backup);
          } finally {
            this.setUpdate({ state: STANDALONE_UPDATE_ROLLED_BACK, progress: null });
            if (wasRunning) await this.startInternal().catch(() => undefined);
          }
        }
      }),
    );
  }

  // 只保留当前版本与上一个版本的服务端资源。
  private async pruneOldVersions(): Promise<void> {
    const keep = new Set([this.state?.serverVersion, this.state?.previousServerVersion].filter(Boolean));
    const entries = await readdir(this.deps.layout.versionsDir).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((name) => !keep.has(name))
        .map((name) => rm(join(this.deps.layout.versionsDir, name), { recursive: true, force: true })),
    );
  }

  // ---------- 备份 ----------

  async listBackups(): Promise<StandaloneBackup[]> {
    const names = await readdir(this.deps.layout.backupsDir).catch(() => [] as string[]);
    const backups: StandaloneBackup[] = [];
    for (const name of names) {
      try {
        const meta = JSON.parse(await readFile(join(this.deps.layout.backup(name), BACKUP_META), "utf-8")) as StandaloneBackup;
        backups.push({ ...meta, fileName: name });
      } catch {
        // 不完整的备份目录不列出。
      }
    }
    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // 「立即备份」：停服务冷复制数据目录，完成后恢复运行。
  backupNow(): Promise<void> {
    return this.serial(async () => {
      const wasRunning = this.running !== null;
      try {
        await this.stopInternal({ strict: true });
        await this.createBackup(this.state?.serverVersion ?? "unknown", BACKUP_REASON_MANUAL);
      } finally {
        if (wasRunning) await this.startInternal();
      }
    });
  }

  // 「恢复」：用指定备份替换数据目录。
  restoreBackup(fileName: string): Promise<void> {
    return this.serial(async () => {
      const wasRunning = this.running !== null;
      try {
        await this.stopInternal({ strict: true });
        await this.restoreBackupData(this.deps.layout.backup(fileName));
      } finally {
        if (wasRunning) await this.startInternal();
      }
    });
  }

  // 数据库已停止时调用：把 pgdata 整目录复制成一份备份，只保留最近 MAX_BACKUPS 份。
  private async createBackup(version: string, reason: BackupReason): Promise<string> {
    const createdAt = this.now().toISOString();
    const name = `${createdAt.replace(/[:.]/g, "-")}_${reason}`;
    const dir = this.deps.layout.backup(name);
    try {
      await mkdir(dir, { recursive: true });
      if (existsSync(this.deps.layout.pgData)) {
        await cp(this.deps.layout.pgData, join(dir, BACKUP_DATA), { recursive: true });
      }
      const sizeBytes = await directorySize(join(dir, BACKUP_DATA));
      const meta: StandaloneBackup = { fileName: name, createdAt, version, sizeBytes, reason };
      await writeFile(join(dir, BACKUP_META), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
    } catch (err) {
      // 半成品备份没有 backup.json，不会被列出也不会被清理，失败时当场删掉。
      await rm(dir, { recursive: true, force: true });
      throw err;
    }

    const backups = await this.listBackups();
    await Promise.all(
      backups.slice(MAX_BACKUPS).map((b) => rm(this.deps.layout.backup(b.fileName), { recursive: true, force: true })),
    );
    return dir;
  }

  // 数据库已停止时调用：先把备份完整复制到临时目录，再用两次改名替换数据目录，
  // 任何时刻崩溃都不会丢掉原数据（见 recoverInterruptedRestore）。
  private async restoreBackupData(backupDir: string): Promise<void> {
    const source = join(backupDir, BACKUP_DATA);
    if (!existsSync(source)) return;
    await this.recoverInterruptedRestore();

    const { restoring, aside } = this.restorePaths();
    await rm(restoring, { recursive: true, force: true });
    try {
      await cp(source, restoring, { recursive: true });
    } catch (err) {
      await rm(restoring, { recursive: true, force: true });
      throw err;
    }

    if (existsSync(this.deps.layout.pgData)) await rename(this.deps.layout.pgData, aside);
    await rename(restoring, this.deps.layout.pgData);
    await rm(aside, { recursive: true, force: true });
  }

  private restorePaths(): { restoring: string; aside: string } {
    return {
      restoring: `${this.deps.layout.pgData}.restoring`,
      aside: `${this.deps.layout.pgData}.before-restore`,
    };
  }

  // 上次恢复在两次改名之间中断：数据目录不在而原数据还在一旁，就把原数据挪回；
  // 数据目录已换好，一旁的旧数据和没复制完的临时目录直接删掉。
  private async recoverInterruptedRestore(): Promise<void> {
    const { restoring, aside } = this.restorePaths();
    if (existsSync(aside)) {
      if (existsSync(this.deps.layout.pgData)) await rm(aside, { recursive: true, force: true });
      else await rename(aside, this.deps.layout.pgData);
    }
    await rm(restoring, { recursive: true, force: true });
  }

  // ---------- 切换 ----------

  // 已连上远程服务器后调用：停止单机模式，数据保留。
  stopForRemote(): Promise<void> {
    return this.stop();
  }

  // ---------- 退出 ----------

  // App 退出：中止下载，排队正常停止；队列被迁移、备份等长操作占住超过 timeoutMs 时，
  // 不再等待，直接停掉服务端进程（含启动中的）和数据库。
  async shutdown(timeoutMs: number): Promise<void> {
    this.shuttingDown = true;
    this.installAbort?.abort();
    this.updateAbort?.abort();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    });
    const graceful = this.serial(() => this.stopInternal()).then(
      () => false,
      () => false,
    );
    const forced = await Promise.race([graceful, timedOut]);
    clearTimeout(timer);
    if (!forced) return;

    this.deps.log("standalone graceful stop timed out, forcing");
    this.stopping = true;
    const handles = [this.running?.handle, this.startingHandle].filter((h): h is ServerHandle => Boolean(h));
    this.running = null;
    this.startingHandle = null;
    await Promise.all(handles.map((h) => h.stop().catch(() => undefined)));
    if (this.state?.postgresVersion) await this.ops.stopPostgres(this.postgresPaths()).catch(() => undefined);
  }
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}
