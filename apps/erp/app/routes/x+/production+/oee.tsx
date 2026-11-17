// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { requirePermissions } from "@carbon/auth/auth.server";
import { useLoaderQuery } from "@carbon/query";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  HStack,
  Loading,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr
} from "@carbon/react";
import type { ChartConfig } from "@carbon/react/Chart";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent
} from "@carbon/react/Chart";
import { formatDurationMilliseconds } from "@carbon/utils";
import {
  type CalendarDate,
  getLocalTimeZone,
  parseDate,
  toCalendarDate,
  today
} from "@internationalized/date";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { DateRange } from "@react-types/datepicker";
import { useMemo } from "react";
import { LuActivity, LuCheck, LuGauge, LuTimer } from "react-icons/lu";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { DateSelect, Empty, MetricCard } from "~/components";
import { usePercentFormatter } from "~/hooks";
import { getLocationsList } from "~/modules/resources/resources.service";
import { getUserDefaults } from "~/modules/users/users.service";
import type { OeeResponse } from "~/routes/api+/production.oee";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";

export const handle: Handle = {
  breadcrumb: msg`OEE`,
  to: path.to.productionOee
};

const chartConfig = {
  oee: {
    color: "hsl(var(--primary))",
    label: "OEE"
  }
} satisfies ChartConfig;

/** The day counts of the period options; 92 days is the API's limit. */
const PERIOD_DAYS: Record<string, number> = { week: 7, month: 30, quarter: 90 };

export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId, userId } = await requirePermissions(request, {
    view: "production"
  });

  const [locations, defaults] = await Promise.all([
    getLocationsList(client, companyId),
    getUserDefaults(client, userId, companyId)
  ]);

  const list = (locations.data ?? []).map((location) => ({
    id: location.id,
    name: location.name
  }));
  const defaultLocationId =
    list.find((location) => location.id === defaults.data?.locationId)?.id ??
    list[0]?.id ??
    null;

  return { locations: list, defaultLocationId };
}

export default function ProductionOeeRoute() {
  const { t } = useLingui();
  const { locations, defaultLocationId } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const percent = usePercentFormatter();

  const locationId = searchParams.get("locationId") ?? defaultLocationId;
  const interval = searchParams.get("interval") ?? "week";
  const range = useMemo(
    () => readRange(searchParams, interval, today(getLocalTimeZone())),
    [searchParams, interval]
  );

  const update = (values: Record<string, string>) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(values)) next.set(key, value);
        return next;
      },
      { replace: true }
    );
  };

  const onIntervalChange = (value: string) => {
    if (value === "custom") {
      update({
        interval: value,
        start: range.start.toString(),
        end: range.end.toString()
      });
      return;
    }
    update({ interval: value });
  };

  const onDateRangeChange = (value: DateRange | null) => {
    if (!value) return;
    update({
      interval: "custom",
      start: toCalendarDate(value.start).toString(),
      end: toCalendarDate(value.end).toString()
    });
  };

  const query = locationId
    ? `${path.to.api.productionOee}?${new URLSearchParams({
        locationId,
        start: range.start.toString(),
        end: range.end.toString()
      })}`
    : null;
  const oee = useLoaderQuery<OeeResponse>(query);
  const data = oee.data;
  const isLoading = oee.isFetching || !data;

  const formatRatio = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : percent.format(value);
  const formatTime = (ms: number) =>
    ms > 0 ? formatDurationMilliseconds(ms) : "—";

  const chartData = (data?.days ?? []).map((day) => ({
    day: day.day,
    oee: day.ratios.oee
  }));
  const hasPlannedTime = (data?.totals?.parts.plannedMs ?? 0) > 0;
  const tooLong = range.end.compare(range.start) + 1 > 92;

  return (
    <div className="flex flex-col gap-4 w-full p-4 h-[calc(100dvh-var(--header-height))] overflow-y-auto scrollbar-thin scrollbar-thumb-rounded-full scrollbar-thumb-muted-foreground bg-card">
      <h1 className="sr-only">
        <Trans>OEE</Trans>
      </h1>
      <HStack className="justify-between flex-wrap gap-2">
        <Select
          value={locationId ?? undefined}
          onValueChange={(value) => update({ locationId: value })}
        >
          <SelectTrigger aria-label={t`Location`} className="w-auto min-w-48">
            <SelectValue placeholder={t`Select a location`} />
          </SelectTrigger>
          <SelectContent>
            {locations.map((location) => (
              <SelectItem key={location.id} value={location.id}>
                {location.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DateSelect
          value={interval}
          onValueChange={onIntervalChange}
          options={[
            { value: "week", label: t`7D` },
            { value: "month", label: t`30D` },
            { value: "quarter", label: t`90D` }
          ]}
          dateRange={{ start: range.start, end: range.end }}
          onDateRangeChange={onDateRangeChange}
        />
      </HStack>

      <div className="grid w-full gap-4 grid-cols-2 lg:grid-cols-4">
        <MetricCard
          icon={<LuGauge />}
          title={<Trans>OEE</Trans>}
          value={isLoading ? "…" : formatRatio(data?.totals?.ratios.oee)}
        />
        <MetricCard
          icon={<LuTimer />}
          title={<Trans>Availability</Trans>}
          value={
            isLoading ? "…" : formatRatio(data?.totals?.ratios.availability)
          }
        />
        <MetricCard
          icon={<LuActivity />}
          title={<Trans>Performance</Trans>}
          value={
            isLoading ? "…" : formatRatio(data?.totals?.ratios.performance)
          }
        />
        <MetricCard
          icon={<LuCheck />}
          title={<Trans>Quality</Trans>}
          value={isLoading ? "…" : formatRatio(data?.totals?.ratios.quality)}
        />
      </div>

      {tooLong ? (
        <Card>
          <CardContent>
            <Empty
              title={<Trans>The range is too long</Trans>}
              description={<Trans>Pick a range of 92 days or less.</Trans>}
            />
          </CardContent>
        </Card>
      ) : !isLoading && !hasPlannedTime ? (
        <Card>
          <CardContent>
            <Empty
              title={<Trans>No planned time in this range</Trans>}
              description={
                <Trans>
                  OEE needs shifts on the work centers, or machine run time.
                </Trans>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                <Trans>OEE by day</Trans>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Loading isLoading={isLoading} className="w-full">
                <ChartContainer
                  config={chartConfig}
                  aria-label={t`OEE by day`}
                  className="h-[280px] w-full"
                >
                  <LineChart accessibilityLayer data={chartData}>
                    <CartesianGrid vertical={false} />
                    <YAxis
                      domain={[0, "auto"]}
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      tickFormatter={(value: number) => percent.format(value)}
                    />
                    <XAxis
                      dataKey="day"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      minTickGap={32}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <ChartTooltipContent
                          formatter={(value) =>
                            formatRatio(value as number | null)
                          }
                        />
                      }
                    />
                    <Line
                      dataKey="oee"
                      type="linear"
                      stroke="var(--color-oee)"
                      strokeWidth={2}
                      dot={{ fill: "var(--color-oee)", r: 3 }}
                      connectNulls
                    />
                  </LineChart>
                </ChartContainer>
              </Loading>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <Trans>Work centers</Trans>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Loading isLoading={isLoading} className="w-full">
                <Table>
                  <Thead>
                    <Tr>
                      <Th>
                        <Trans>Work Center</Trans>
                      </Th>
                      <Th>
                        <Trans>Source</Trans>
                      </Th>
                      <Th className="text-right">
                        <Trans>Planned time</Trans>
                      </Th>
                      <Th className="text-right">
                        <Trans>Run time</Trans>
                      </Th>
                      <Th className="text-right">
                        <Trans>Run outside shifts</Trans>
                      </Th>
                      <Th className="text-right">
                        <Trans>Availability</Trans>
                      </Th>
                      <Th className="text-right">
                        <Trans>Performance</Trans>
                      </Th>
                      <Th className="text-right">
                        <Trans>Standard coverage</Trans>
                      </Th>
                      <Th className="text-right">
                        <Trans>Quality</Trans>
                      </Th>
                      <Th className="text-right">
                        <Trans>OEE</Trans>
                      </Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {(data?.workCenters ?? []).map((row) => (
                      <Tr key={row.id}>
                        <Td className="whitespace-nowrap">{row.name}</Td>
                        <Td>
                          <Badge
                            variant={row.source === "Sensor" ? "blue" : "gray"}
                          >
                            {row.source === "Sensor" ? t`Sensor` : t`Operator`}
                          </Badge>
                        </Td>
                        <Td className="text-right tabular-nums">
                          {formatTime(row.parts.plannedMs)}
                        </Td>
                        <Td className="text-right tabular-nums">
                          {formatTime(row.parts.runMs)}
                        </Td>
                        <Td className="text-right tabular-nums">
                          {formatTime(row.parts.runOutsideMs)}
                        </Td>
                        <Td className="text-right tabular-nums">
                          {formatRatio(row.ratios.availability)}
                        </Td>
                        <Td className="text-right tabular-nums">
                          {formatRatio(row.ratios.performance)}
                        </Td>
                        <Td className="text-right tabular-nums">
                          {formatRatio(row.ratios.standardCoverage)}
                        </Td>
                        <Td className="text-right tabular-nums">
                          {formatRatio(row.ratios.quality)}
                        </Td>
                        <Td className="text-right tabular-nums font-medium">
                          {formatRatio(row.ratios.oee)}
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </Loading>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/** The date range of the URL: a preset ending today, or a custom range. */
function readRange(
  searchParams: URLSearchParams,
  interval: string,
  end: CalendarDate
): { start: CalendarDate; end: CalendarDate } {
  const days = PERIOD_DAYS[interval];
  if (days) return { start: end.subtract({ days: days - 1 }), end };
  try {
    const start = parseDate(searchParams.get("start") ?? "");
    const last = parseDate(searchParams.get("end") ?? "");
    if (last.compare(start) >= 0) return { start, end: last };
  } catch {
    // An unreadable custom range falls back to the last 7 days.
  }
  return { start: end.subtract({ days: 6 }), end };
}
