import { FAILURE_CLASSES, type FailureClass } from "@marvis/core/dashboard";
import type { ChartConfig } from "@marvis/ui/components/ui/chart";
import { useT } from "../../../i18n";
import { FAILURE_MONO } from "./chart-tones";

// One bucket's failure counts, keyed by display class. Every class is always
// present (0 when unused) so a bucket can be read without existence checks;
// which of them actually get drawn is `activeFailureClasses`' call.
export type FailureClassCounts = Record<FailureClass, number>;

// Bucket-level totals that ride alongside the per-class counts. `total`
// counts every terminal task in the bucket, not just failures, so the
// tooltip can report a rate.
export interface FailureBucketTotals {
  failed: number;
  total: number;
}

// 单色方案：失败类别按 FAILURE_MONO 灰阶由深到浅区分，顺序跟随
// FAILURE_CLASSES（最需处理的最深）。色值由前景色向 `--card` 混合，暗色模式
// 同样可读；状态色不进图表。
export const FAILURE_CLASS_COLOR: Record<FailureClass, string> = {
  auth: FAILURE_MONO[0],
  rate_limit: FAILURE_MONO[1],
  timeout: FAILURE_MONO[2],
  provider: FAILURE_MONO[3],
  runtime: FAILURE_MONO[4],
  agent: FAILURE_MONO[5],
  other: FAILURE_MONO[6],
};

/**
 * Which classes to draw, in canonical order.
 *
 * Rendering all seven unconditionally would put five permanently-zero rows in
 * every tooltip. Restricting to the classes the window actually contains
 * keeps the legend and tooltip proportional to what happened, and the
 * canonical order keeps a class pinned to the same colour whether or not its
 * neighbours are present.
 */
export function activeFailureClasses(
  data: readonly Partial<Record<FailureClass, number>>[],
): FailureClass[] {
  return FAILURE_CLASSES.filter((c) => data.some((d) => (d[c] ?? 0) > 0));
}

/**
 * Failure rate as a percentage of terminal tasks — "12.5%", "40%".
 *
 * Sub-10% rates keep one decimal because that is the band where a regression
 * shows up first and rounding 1.4% to 1% hides half the movement. A bucket
 * with no terminal tasks at all has no rate to report, so it renders a dash
 * rather than a 0% that reads as "healthy".
 */
export function formatRate(failed: number, total: number): string {
  if (total <= 0) return "—";
  const pct = (failed / total) * 100;
  return `${pct >= 10 || pct === 0 ? Math.round(pct) : pct.toFixed(1)}%`;
}

/**
 * Translated label for a Recharts series name.
 *
 * Recharts passes the `dataKey` through as the tooltip item's `name`, so a
 * formatter that echoes it renders the raw class id ("rate_limit"). Look it
 * up in the same config that drives the legend, and fall back to the key
 * itself if the config ever loses an entry.
 */
export function labelOf(
  config: ChartConfig,
  name: string | number | undefined,
): string {
  const key = String(name ?? "");
  const label = config[key]?.label;
  return typeof label === "string" ? label : key;
}

/** Translated Recharts config for the failure-class series. */
export function useFailureClassConfig(): ChartConfig {
  const { t } = useT("usage");
  return {
    auth: { label: t(($) => $.errors.class.auth), color: FAILURE_CLASS_COLOR.auth },
    rate_limit: {
      label: t(($) => $.errors.class.rate_limit),
      color: FAILURE_CLASS_COLOR.rate_limit,
    },
    timeout: {
      label: t(($) => $.errors.class.timeout),
      color: FAILURE_CLASS_COLOR.timeout,
    },
    provider: {
      label: t(($) => $.errors.class.provider),
      color: FAILURE_CLASS_COLOR.provider,
    },
    runtime: {
      label: t(($) => $.errors.class.runtime),
      color: FAILURE_CLASS_COLOR.runtime,
    },
    agent: { label: t(($) => $.errors.class.agent), color: FAILURE_CLASS_COLOR.agent },
    other: { label: t(($) => $.errors.class.other), color: FAILURE_CLASS_COLOR.other },
  } satisfies ChartConfig;
}
