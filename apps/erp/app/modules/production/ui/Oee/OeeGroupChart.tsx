import type { ChartConfig } from "@carbon/react/Chart";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent
} from "@carbon/react/Chart";
import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { Bar, BarChart, LabelList, XAxis, YAxis } from "recharts";
import { formatPercent, type OeeGroup } from "./types";

const chartConfig = {
  value: {
    color: "hsl(var(--primary))"
  }
} satisfies ChartConfig;

const OeeGroupChart = ({ groups }: { groups: OeeGroup[] }) => {
  const { t } = useLingui();

  const data = useMemo(
    () =>
      groups.map((group) => ({
        key: group.name,
        value: (group.oee ?? 0) * 100,
        availability: group.availability,
        performance: group.performance,
        quality: group.quality
      })),
    [groups]
  );

  const yAxisWidth = useMemo(
    () =>
      data.reduce((max, item) => Math.max(max, item.key?.length || 0), 0) * 10,
    [data]
  );

  return (
    <ChartContainer
      config={chartConfig}
      style={{ height: `${Math.max(data.length, 3) * 40}px` }}
    >
      <BarChart
        accessibilityLayer
        data={data}
        layout="vertical"
        margin={{ right: 30 }}
      >
        <YAxis
          dataKey="key"
          type="category"
          tickLine={false}
          axisLine={false}
          width={yAxisWidth}
        />
        <XAxis type="number" hide domain={[0, 100]} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, _name, item) => {
                const payload = item?.payload as (typeof data)[number];
                return (
                  <div className="flex flex-col gap-1 min-w-44">
                    <div className="flex justify-between gap-2">
                      <span className="font-medium">{t`OEE`}</span>
                      <span className="font-mono">
                        {(value as number).toFixed(1)}%
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span>{t`Availability`}</span>
                      <span className="font-mono">
                        {formatPercent(payload?.availability)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span>{t`Performance`}</span>
                      <span className="font-mono">
                        {formatPercent(payload?.performance)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span>{t`Quality`}</span>
                      <span className="font-mono">
                        {formatPercent(payload?.quality)}
                      </span>
                    </div>
                  </div>
                );
              }}
            />
          }
        />
        <Bar dataKey="value" fill="var(--color-value)" radius={2}>
          <LabelList
            dataKey="value"
            position="right"
            formatter={(value: number) => `${value.toFixed(1)}%`}
            offset={8}
            className="fill-foreground"
            fontSize={12}
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
};

export default OeeGroupChart;
