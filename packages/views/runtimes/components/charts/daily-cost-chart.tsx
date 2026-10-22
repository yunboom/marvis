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
import type { DailyCostStackData } from "../../utils";
import { useT } from "../../../i18n";
import { CHART_MONO, monoBarFill } from "./chart-tones";

// Four-segment stack (input / output / cache read / cache write) — every
// category `estimateCost` bills for, so the bars add up to the same money the
// Cost KPI reports. The tooltip derives Total by summing the segments it can
// see, so a category left out of this config is a category left out of the
// user's total (MUL-6334: cache read alone was >50% of some buckets).
//
// 单色方案与 DailyTokensChart 相同：同一系列用同一灰阶，费用和 Token
// 两个视图读起来是同一张图的两种刻度。
export const costStackConfig = {
  input: { label: "Input", color: CHART_MONO[1] },
  output: { label: "Output", color: CHART_MONO[2] },
  cacheRead: { label: "Cache read", color: CHART_MONO[4] },
  cacheWrite: { label: "Cache write", color: CHART_MONO[3] },
} satisfies ChartConfig;

export function DailyCostChart({ data }: { data: DailyCostStackData[] }) {
  const { t } = useT("runtimes");
  // No internal empty-state — the parent decides what to show in place of
  // the chart (often a diagnostic explaining *why* there's no cost). Letting
  // recharts render an empty axis would be both ugly and uninformative.
  return (
    <ChartContainer config={costStackConfig} className="aspect-[3/1] w-full">
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
          tickFormatter={(v: number) => `$${v}`}
          width="auto"
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              formatter={(value, name) =>
                typeof value === "number"
                  ? `$${value.toFixed(2)} ${name}`
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
                      ${total.toFixed(2)}
                    </span>
                  </div>
                );
              }}
            />
          }
        />
        {/* Legend is intentionally rendered by the parent (in the chart card
            header, top-right) so the chart body stays clean and gets the full
            vertical real estate. */}
        <Bar
          dataKey="input"
          stackId="cost"
          {...monoBarFill("input")}
          radius={[0, 0, 0, 0]}
        />
        <Bar
          dataKey="output"
          stackId="cost"
          {...monoBarFill("output")}
          radius={[0, 0, 0, 0]}
        />
        <Bar
          dataKey="cacheRead"
          stackId="cost"
          {...monoBarFill("cacheRead")}
          radius={[0, 0, 0, 0]}
        />
        <Bar
          dataKey="cacheWrite"
          stackId="cost"
          {...monoBarFill("cacheWrite")}
          radius={[3, 3, 0, 0]}
        />
      </BarChart>
    </ChartContainer>
  );
}
