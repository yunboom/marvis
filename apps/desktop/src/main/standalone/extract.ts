// 单机模式资源包解压：用系统自带的 tar 解 .tar.xz，先解到临时目录再整体替换，避免留下解了一半的目录。
import { execFile } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";

export type ExecRunner = (file: string, args: string[], options?: { cwd?: string }) => Promise<void>;

const execFileAsync = promisify(execFile);

const PLATFORM_WINDOWS = "win32";
const DEFAULT_TAR = "tar";
const TMP_SUFFIX = ".tmp";

const defaultRunner: ExecRunner = async (file, args, options) => {
  await execFileAsync(file, args, { cwd: options?.cwd });
};

// Windows 10 起自带 bsdtar（System32\tar.exe），用绝对路径避免 PATH 里的其他 tar（如 Git 的 GNU tar 不认盘符路径）。
export function systemTarPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== PLATFORM_WINDOWS) return DEFAULT_TAR;

  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (!systemRoot) return DEFAULT_TAR;

  return `${systemRoot}\\System32\\tar.exe`;
}

export async function extractTarXz(archive: string, destDir: string, run: ExecRunner = defaultRunner): Promise<void> {
  await mkdir(destDir, { recursive: true });

  await run(systemTarPath(), ["-xJf", archive, "-C", destDir]);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function installArchive(archive: string, finalDir: string, run: ExecRunner = defaultRunner): Promise<void> {
  const tmpDir = finalDir + TMP_SUFFIX;
  await rm(tmpDir, { recursive: true, force: true });

  try {
    await extractTarXz(archive, tmpDir, run);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }

  if (await exists(finalDir)) await rm(finalDir, { recursive: true, force: true });

  await rename(tmpDir, finalDir);
}
