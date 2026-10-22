import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@marvis/ui/components/ui/chart";
import { formatTokens, type DailyTokenData } from "../../utils";
import { useLocale, useT } from "../../../i18n";
import { CHART_MONO, monoBarFill } from "./chart-tones";

// Four-segment stack — input / output / cache read / cache write. Unlike the
// cost chart, cache reads ARE visible here: a typical day on Claude shows
// cache reads dominating raw token counts (often 10×+ input), so the user
// only sees the real shape of usage when reads are stacked in. The cost
// chart drops them for the opposite reason (their dollar contribution is
// two orders of magnitude smaller and would be visually invisible).
//
// 单色方案：静止的柱子统一浅灰，悬停的那一根按 CHART_MONO 由深到浅显示
// input → output → cache read → cache write，图例和提示框也用这组色阶。
export const tokenStackConfig = {
  input: { label: "Input", color: CHART_MONO[1] },
  output: { label: "Output", color: CHART_MONO[2] },
  cacheRead: { label: "Cache read", color: CHART_MONO[4] },
  cacheWrite: { label: "Cache write", color: CHART_MONO[3] },
} satisfies ChartConfig;

export function DailyTokensChart({ data }: { data: DailyTokenData[] }) {
  const { t } = useT("runtimes");
  const locale = useLocale();
  // No internal empty-state — same convention as DailyCostChart: the parent
  // decides what to render when there's nothing to show.
  return (
    <ChartContainer config={tokenStackConfig} className="aspect-[3/1] w-full">
      <BarChart data={data} barCategoryGap="30%" margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval="preserveStartEnd"
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(v: number) => formatTokens(v)}
          width="auto"
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              formatter={(value, name) =>
                typeof value === "number"
                  ? `${formatTokens(value)} ${name}`
                  : `${value} ${name}`
              }
              footer={(payload) => {
                const total = payload.reduce(
                  (sum, item) =>
                    sum +
                    (typeof item.value === "number" ? item.value : 0),
                  0,
                );
                return (
                  <div className="flex items-center justify-between gap-2 font-medium">
                    <span>{t(($) => $.charts.tooltip_total)}</span>
                    <span className="font-mono tabular-nums">
                      {total.toLocaleString(locale)}
                    </span>
                  </div>
                );
              }}
            />
          }
        />
        {/* Legend is rendered by the parent in the chart card header. */}
        <Bar
          dataKey="input"
          stackId="tokens"
          {...monoBarFill("input")}
          radius={[0, 0, 0, 0]}
        />
        <Bar
          dataKey="output"
          stackId="tokens"
          {...monoBarFill("output")}
          radius={[0, 0, 0, 0]}
        />
        <Bar
          dataKey="cacheRead"
          stackId="tokens"
          {...monoBarFill("cacheRead")}
          radius={[0, 0, 0, 0]}
        />
        <Bar
          dataKey="cacheWrite"
          stackId="tokens"
          {...monoBarFill("cacheWrite")}
          radius={[3, 3, 0, 0]}
        />
      </BarChart>
    </ChartContainer>
  );
}
