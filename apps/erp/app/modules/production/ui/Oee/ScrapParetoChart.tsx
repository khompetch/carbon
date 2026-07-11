import type { ChartConfig } from "@carbon/react/Chart";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent
} from "@carbon/react/Chart";
import { useMemo } from "react";
import { Bar, BarChart, LabelList, XAxis, YAxis } from "recharts";

const chartConfig = {
  quantity: {
    color: "hsl(var(--chart-1))"
  }
} satisfies ChartConfig;

const ScrapParetoChart = ({
  data
}: {
  data: { reason: string; quantity: number }[];
}) => {
  const yAxisWidth = useMemo(
    () =>
      data.reduce((max, item) => Math.max(max, item.reason?.length || 0), 0) *
      10,
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
          dataKey="reason"
          type="category"
          tickLine={false}
          axisLine={false}
          width={yAxisWidth}
        />
        <XAxis type="number" hide />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="quantity" fill="var(--color-quantity)" radius={2}>
          <LabelList
            dataKey="quantity"
            position="right"
            offset={8}
            className="fill-foreground"
            fontSize={12}
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
};

export default ScrapParetoChart;
