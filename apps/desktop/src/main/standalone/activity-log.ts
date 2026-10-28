// 单机模式的运行记录：同时打到主进程控制台和日志目录里的文件，「查看日志」能看到失败原因。
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type ActivityLogger = (message: string, extra?: Record<string, unknown>) => void;

// 写文件失败不影响主流程：日志只用于排查。
export function createActivityLogger(logFile: string, now: () => Date = () => new Date()): ActivityLogger {
  let ready: Promise<unknown> | null = null;
  let pending: Promise<unknown> = Promise.resolve();

  return (message, extra) => {
    console.log(`[standalone] ${message}`, extra ?? "");

    const line = `${now().toISOString()} ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`;
    ready ??= mkdir(dirname(logFile), { recursive: true });
    // 串起来写，保证行的先后顺序。
    pending = pending
      .then(() => ready)
      .then(() => appendFile(logFile, line))
      .catch(() => undefined);
  };
}
