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
import { useLocale, useT } from "../../../i18n";
import { CHART_MONO, monoBarFill } from "./chart-tones";

// Three-segment stack — completed runs at the bottom, then cancelled (a
// manual stop is an outcome, not an error), failed on top. 单色方案：悬停时
// 由深到浅显示三段，状态色不进图表。
const tasksChartConfig = {
  completed: { label: "Completed", color: CHART_MONO[1] },
  cancelled: { label: "Cancelled", color: CHART_MONO[3] },
  failed: { label: "Failed", color: CHART_MONO[5] },
} satisfies ChartConfig;

export interface DailyTasksData {
  date: string;
  label: string;
  completed: number;
  failed: number;
  cancelled: number;
}

export function DailyTasksChart({ data }: { data: DailyTasksData[] }) {
  const { t } = useT("runtimes");
  const locale = useLocale();
  return (
    <ChartContainer config={tasksChartConfig} className="aspect-[3/1] w-full">
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
          allowDecimals={false}
          width="auto"
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              formatter={(value, name) => `${value} ${name}`}
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
        <Bar
          dataKey="completed"
          stackId="tasks"
          {...monoBarFill("completed")}
          radius={[0, 0, 0, 0]}
        />
        <Bar
          dataKey="cancelled"
          stackId="tasks"
          {...monoBarFill("cancelled")}
          radius={[0, 0, 0, 0]}
        />
        <Bar
          dataKey="failed"
          stackId="tasks"
          {...monoBarFill("failed")}
          radius={[3, 3, 0, 0]}
        />
      </BarChart>
    </ChartContainer>
  );
}
