import { useEffect, useState } from "react";
import { useLocale, useT } from "@marvis/views/i18n";

const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * BYTES_PER_MB;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const SECONDS_PER_MINUTE = 60;

// 字节数换算成保留一位小数的 MB。
export function megabytes(bytes: number): string {
  return (bytes / BYTES_PER_MB).toFixed(1);
}

// 字节数向上取整到整数 MB，用于「约 {size} MB」。
export function approxMegabytes(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_MB);
}

// 备份大小：满 1 GB 用 GB，否则用 MB。
export function formatBackupSize(bytes: number): string {
  if (bytes >= BYTES_PER_GB) return `${(bytes / BYTES_PER_GB).toFixed(1)} GB`;

  return `${megabytes(bytes)} MB`;
}

// 每隔 intervalMs 刷新一次的当前时间，用于「已运行」「上次检查」这类相对时间。
export function useNow(intervalMs = MS_PER_MINUTE): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);

    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
}

// 「已运行 {duration}」：不足 1 小时按分钟，不足 1 天按小时，否则按天。
export function useRunningDuration(): (startedAt: string, now: number) => string {
  const { t } = useT("settings");

  return (startedAt, now) => {
    const minutes = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / MS_PER_MINUTE));
    if (minutes < MINUTES_PER_HOUR) {
      return t(($) => $.desktop.standalone.settings.duration_minutes, { count: Math.max(1, minutes) });
    }

    const hours = Math.floor(minutes / MINUTES_PER_HOUR);
    if (hours < HOURS_PER_DAY) return t(($) => $.desktop.standalone.settings.duration_hours, { count: hours });

    return t(($) => $.desktop.standalone.settings.duration_days, { count: Math.floor(hours / HOURS_PER_DAY) });
  };
}

// 剩余时间：不足 1 分钟按秒，否则按分钟。没有估计值时为 null。
export function useEtaLabel(): (seconds: number | null) => string | null {
  const { t } = useT("settings");

  return (seconds) => {
    if (seconds === null) return null;
    if (seconds < SECONDS_PER_MINUTE) {
      return t(($) => $.desktop.standalone.prepare.eta_seconds, { count: Math.max(1, Math.ceil(seconds)) });
    }

    return t(($) => $.desktop.standalone.prepare.eta_minutes, { count: Math.ceil(seconds / SECONDS_PER_MINUTE) });
  };
}

// 备份日期：按界面语言显示月和日，例如「10月20日」。
export function useBackupDate(): (iso: string) => string {
  const locale = useLocale();

  return (iso) => new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }).format(new Date(iso));
}
