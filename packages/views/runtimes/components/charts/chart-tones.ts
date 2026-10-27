// 单色图表色阶：趋势图、排行榜进度条、失败构成都只用前景色的深浅，
// 状态色留给状态。色值由 `--foreground` 向 `--card` 混合得出，亮暗主题自动跟随。
const mono = (pct: number) =>
  `color-mix(in oklch, var(--foreground) ${pct}%, var(--card))`;

/** 系列色阶，由深到浅；用作悬停柱、图例和提示框色块。 */
export const CHART_MONO = {
  1: "var(--foreground)",
  2: mono(72),
  3: mono(50),
  4: mono(32),
  5: mono(20),
} as const;

/** 静止状态的柱子：统一浅灰，悬停的那一根按系列色阶显示。 */
export const CHART_BAR_REST = mono(12);

/**
 * 柱状图的单色填充：静止为浅灰，悬停（选中）时切换为该系列在
 * ChartContainer 配置里的颜色（`--color-<key>`）。
 */
export function monoBarFill(dataKey: string) {
  return {
    fill: CHART_BAR_REST,
    activeBar: { fill: `var(--color-${dataKey})` },
  };
}

/** 失败类别的灰阶，顺序与 FAILURE_CLASSES 一致（最需处理的最深）。 */
export const FAILURE_MONO = [
  "var(--foreground)",
  mono(80),
  mono(62),
  mono(46),
  mono(31),
  mono(19),
  mono(12),
] as const;
