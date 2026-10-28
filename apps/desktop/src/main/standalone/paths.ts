import { join } from "node:path";

// 正式版的数据目录名，固定写死：以后改产品名也不会让单机模式的数据「丢失」。
export const PRODUCTION_APP_DIR = "Marvis";

// 单机模式在应用数据目录下的子目录名。
const STANDALONE_DIR = "server";

// 版本号、文件名只能是一段普通名字，不能带路径分隔符或 ..。
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeSegment(value: string): string {
  if (!SAFE_SEGMENT.test(value) || value.includes("..")) {
    throw new Error(`unsafe path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

// 单机模式的根目录：正式版固定在 appData/Marvis/server，开发版跟随开发版应用名，与正式版数据隔离。
export function standaloneRoot(appDataDir: string, opts: { isDev: boolean; appName: string }): string {
  const appDir = opts.isDev ? opts.appName : PRODUCTION_APP_DIR;
  return join(appDataDir, appDir, STANDALONE_DIR);
}

export interface StandaloneLayout {
  root: string;
  versionsDir: string;
  postgresRoot: string;
  pgData: string;
  uploadsDir: string;
  backupsDir: string;
  downloadsDir: string;
  logsDir: string;
  runDir: string;
  stateFile: string;
  secretsFile: string;
  serverPidFile: string;
  serverLog: string;
  postgresLog: string;
  // 单机模式自身的运行记录：下载、安装、启停的失败原因，供「查看日志」查看。
  activityLog: string;
  serverDir(version: string): string;
  postgresDir(version: string): string;
  download(fileName: string): string;
  backup(fileName: string): string;
}

// 根目录下的文件布局，见技术方案「本机目录」。
export function standaloneLayout(root: string): StandaloneLayout {
  const versionsDir = join(root, "versions");
  const postgresRoot = join(root, "postgres");
  const downloadsDir = join(root, "downloads");
  const backupsDir = join(root, "backups");
  const logsDir = join(root, "logs");
  const runDir = join(root, "run");

  return {
    root,
    versionsDir,
    postgresRoot,
    pgData: join(root, "pgdata"),
    uploadsDir: join(root, "uploads"),
    backupsDir,
    downloadsDir,
    logsDir,
    runDir,
    stateFile: join(root, "config.json"),
    secretsFile: join(root, "secrets.enc"),
    serverPidFile: join(runDir, "server.pid"),
    serverLog: join(logsDir, "server.log"),
    postgresLog: join(logsDir, "postgres.log"),
    activityLog: join(logsDir, "standalone.log"),
    serverDir: (version) => join(versionsDir, safeSegment(version)),
    postgresDir: (version) => join(postgresRoot, safeSegment(version)),
    download: (fileName) => join(downloadsDir, safeSegment(fileName)),
    backup: (fileName) => join(backupsDir, safeSegment(fileName)),
  };
}
