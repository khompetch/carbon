// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { authorize } from "@carbon/auth/auth.server";
import { OEE_GOOD, type OeeTone, oeeTone } from "@carbon/planning/oee";
import { useLoaderQuery } from "@carbon/query";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  HStack,
  Loading,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  Tbody,
  Td,
  Tfoot,
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
import { formatDate, formatDurationMilliseconds } from "@carbon/utils";
import {
  type CalendarDate,
  getLocalTimeZone,
  parseDate,
  toCalendarDate,
  today
} from "@internationalized/date";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useLocale } from "@react-aria/i18n";
import type { DateRange } from "@react-types/datepicker";
import { useMemo } from "react";
import {
  LuActivity,
  LuCheck,
  LuChevronDown,
  LuGauge,
  LuTimer
} from "react-icons/lu";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis
} from "recharts";
import { DateSelect, Empty, MetricCard } from "~/components";
import { usePercentFormatter, useQuantityFormatter } from "~/hooks";
import { getLocationsList } from "~/modules/resources/resources.service";
import { getUserDefaults } from "~/modules/users/users.service";
import type { OeeResponse } from "~/routes/api+/production.oee";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";

export const handle: Handle = {
  breadcrumb: msg`OEE`,
  to: path.to.productionOee
};

/** The ratios the chart can show, in menu order. */
const METRICS = ["oee", "availability", "performance", "quality"] as const;
type Metric = (typeof METRICS)[number];

/** The bar fill of each OEE tone (hue only for meaning). */
const TONE_FILL: Record<OeeTone, string> = {
  good: "bg-emerald-500",
  warn: "bg-yellow-500",
  danger: "bg-red-500",
  neutral: "bg-foreground/70"
};

/** The day counts of the period options; 92 days is the API's limit. */
const PERIOD_DAYS: Record<string, number> = { week: 7, month: 30, quarter: 90 };

export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId, userId } = await authorize(request, {
    "production.unattributedTime": "View"
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
  const { locale } = useLocale();
  const { locations, defaultLocationId } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const percent = usePercentFormatter("progress");
  const formatQuantity = useQuantityFormatter();

  const locationId = searchParams.get("locationId") ?? defaultLocationId;
  const interval = searchParams.get("interval") ?? "week";
  const metric = readMetric(searchParams.get("metric"));
  const range = useMemo(
    () => readRange(searchParams, interval, today(getLocalTimeZone())),
    [searchParams, interval]
  );

  const metricLabels: Record<Metric, string> = {
    oee: t`OEE`,
    availability: t`Availability`,
    performance: t`Performance`,
    quality: t`Quality`
  };
  const metricLabel = metricLabels[metric];
  const chartConfig = {
    value: { color: "hsl(var(--primary))", label: metricLabel }
  } satisfies ChartConfig;

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
    ms > 0 ? formatDurationMilliseconds(ms, { style: "short" }) : "—";
  const formatDay = (day: string) =>
    formatDate(day, { month: "short", day: "numeric" }, locale);

  const chartData = (data?.days ?? []).map((day) => ({
    day: day.day,
    value: day.ratios[metric]
  }));
  const totals = data?.totals;
  const hasPlannedTime = (totals?.parts.plannedMs ?? 0) > 0;
  const tooLong = range.end.compare(range.start) + 1 > 92;

  // The context line under each metric: what the ratio was divided from.
  const descriptions = totals
    ? {
        oee: t`Availability × Performance × Quality`,
        availability:
          totals.parts.plannedMs > 0
            ? t`${formatTime(totals.parts.runMs)} run of ${formatTime(totals.parts.plannedMs)} planned`
            : undefined,
        performance:
          totals.ratios.standardCoverage === null
            ? undefined
            : t`A standard covers ${percent.format(totals.ratios.standardCoverage)} of run time`,
        quality:
          totals.parts.totalPieces > 0
            ? t`${formatQuantity(
                totals.parts.totalPieces -
                  Math.min(totals.parts.badPieces, totals.parts.totalPieces)
              )} good of ${formatQuantity(totals.parts.totalPieces)} pieces`
            : undefined
      }
    : null;

  return (
    <div className="@container flex flex-col gap-4 w-full p-4 h-[calc(100dvh-var(--header-height))] overflow-y-auto scrollbar-thin scrollbar-thumb-rounded-full scrollbar-thumb-muted-foreground bg-card">
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

      <div className="grid w-full gap-4 grid-cols-2 @4xl:grid-cols-4 max-md:gap-3">
        <MetricCard
          icon={<LuGauge />}
          title={<Trans>OEE</Trans>}
          value={isLoading ? "…" : formatRatio(totals?.ratios.oee)}
          description={isLoading ? undefined : descriptions?.oee}
        />
        <MetricCard
          icon={<LuTimer />}
          title={<Trans>Availability</Trans>}
          value={isLoading ? "…" : formatRatio(totals?.ratios.availability)}
          description={isLoading ? undefined : descriptions?.availability}
        />
        <MetricCard
          icon={<LuActivity />}
          title={<Trans>Performance</Trans>}
          value={isLoading ? "…" : formatRatio(totals?.ratios.performance)}
          description={isLoading ? undefined : descriptions?.performance}
        />
        <MetricCard
          icon={<LuCheck />}
          title={<Trans>Quality</Trans>}
          value={isLoading ? "…" : formatRatio(totals?.ratios.quality)}
          description={isLoading ? undefined : descriptions?.quality}
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
            <CardHeader className="flex-row items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="secondary"
                    rightIcon={<LuChevronDown />}
                    className="hover:bg-background/80"
                  >
                    <Trans>{metricLabel} by day</Trans>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="start">
                  <DropdownMenuRadioGroup
                    value={metric}
                    onValueChange={(value) => update({ metric: value })}
                  >
                    {METRICS.map((key) => (
                      <DropdownMenuRadioItem key={key} value={key}>
                        {metricLabels[key]}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </CardHeader>
            <CardContent>
              <Loading isLoading={isLoading} className="w-full">
                <ChartContainer
                  config={chartConfig}
                  aria-label={t`${metricLabel} by day`}
                  className="h-[280px] w-full"
                >
                  <BarChart accessibilityLayer data={chartData}>
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
                      minTickGap={16}
                      tickFormatter={(value: string) => formatDay(value)}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <ChartTooltipContent
                          labelFormatter={(value) =>
                            formatDate(
                              String(value),
                              {
                                weekday: "short",
                                month: "short",
                                day: "numeric"
                              },
                              locale
                            )
                          }
                          formatter={(value) =>
                            formatRatio(value as number | null)
                          }
                        />
                      }
                    />
                    {metric === "oee" && (
                      <ReferenceLine
                        y={OEE_GOOD}
                        stroke="hsl(var(--muted-foreground))"
                        strokeDasharray="4 4"
                        label={{
                          value: t`Good from ${percent.format(OEE_GOOD)}`,
                          position: "insideTopLeft",
                          fill: "hsl(var(--muted-foreground))",
                          fontSize: 11
                        }}
                      />
                    )}
                    <Bar
                      dataKey="value"
                      fill="var(--color-value)"
                      radius={2}
                      maxBarSize={48}
                    />
                  </BarChart>
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
                      <Th className="whitespace-nowrap">
                        <Trans>OEE</Trans>
                      </Th>
                      <Th className="text-right whitespace-nowrap">
                        <Trans>Availability</Trans>
                      </Th>
                      <Th className="text-right whitespace-nowrap">
                        <Trans>Performance</Trans>
                      </Th>
                      <Th className="text-right whitespace-nowrap">
                        <Trans>Quality</Trans>
                      </Th>
                      <Th className="text-right whitespace-nowrap">
                        <Trans>Planned time</Trans>
                      </Th>
                      <Th className="text-right whitespace-nowrap">
                        <Trans>Run time</Trans>
                      </Th>
                      <Th className="text-right whitespace-nowrap">
                        <Trans>Run outside shifts</Trans>
                      </Th>
                      <Th className="text-right whitespace-nowrap">
                        <Trans>Standard coverage</Trans>
                      </Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {(data?.workCenters ?? []).map((row) => (
                      <Tr key={row.id}>
                        <Td className="whitespace-nowrap font-medium">
                          {row.name}
                        </Td>
                        <Td>
                          <Badge
                            variant={row.source === "Sensor" ? "blue" : "gray"}
                          >
                            {row.source === "Sensor" ? t`Sensor` : t`Operator`}
                          </Badge>
                        </Td>
                        <Td>
                          <OeeMeter
                            value={row.ratios.oee}
                            label={formatRatio(row.ratios.oee)}
                          />
                        </Td>
                        <RatioCells
                          parts={row.parts}
                          ratios={row.ratios}
                          formatRatio={formatRatio}
                          formatTime={formatTime}
                        />
                      </Tr>
                    ))}
                  </Tbody>
                  {totals && (data?.workCenters.length ?? 0) > 1 && (
                    <Tfoot className="border-t border-border">
                      <Tr>
                        <Td className="whitespace-nowrap" colSpan={2}>
                          <Trans>All work centers</Trans>
                        </Td>
                        <Td>
                          <OeeMeter
                            value={totals.ratios.oee}
                            label={formatRatio(totals.ratios.oee)}
                          />
                        </Td>
                        <RatioCells
                          parts={totals.parts}
                          ratios={totals.ratios}
                          formatRatio={formatRatio}
                          formatTime={formatTime}
                        />
                      </Tr>
                    </Tfoot>
                  )}
                </Table>
              </Loading>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

type OeeTotals = NonNullable<OeeResponse["totals"]>;

/** The ratio and time cells of one table row, after the OEE meter. */
function RatioCells({
  parts,
  ratios,
  formatRatio,
  formatTime
}: OeeTotals & {
  formatRatio: (value: number | null) => string;
  formatTime: (ms: number) => string;
}) {
  const cell = "text-right tabular-nums whitespace-nowrap";
  return (
    <>
      <Td className={cell}>{formatRatio(ratios.availability)}</Td>
      <Td className={cell}>{formatRatio(ratios.performance)}</Td>
      <Td className={cell}>{formatRatio(ratios.quality)}</Td>
      <Td className={cell}>{formatTime(parts.plannedMs)}</Td>
      <Td className={cell}>{formatTime(parts.runMs)}</Td>
      <Td className={cell}>{formatTime(parts.runOutsideMs)}</Td>
      <Td className={cell}>{formatRatio(ratios.standardCoverage)}</Td>
    </>
  );
}

/** OEE as a short bar, colored by how it reads against the good mark. */
function OeeMeter({ value, label }: { value: number | null; label: string }) {
  const { t } = useLingui();
  // No OEE (no planned time, no standard or no pieces): no bar to draw.
  if (value === null) {
    return (
      <div className="flex w-36 justify-end text-sm text-muted-foreground">
        {label}
      </div>
    );
  }
  return (
    <div className="flex w-36 items-center gap-2">
      <Progress
        value={Math.min(value * 100, 100)}
        aria-label={t`OEE`}
        className="h-1.5 min-w-0 flex-1"
        indicatorClassName={TONE_FILL[oeeTone(value)]}
      />
      <span className="min-w-12 shrink-0 text-right text-sm font-medium tabular-nums">
        {label}
      </span>
    </div>
  );
}

function readMetric(value: string | null): Metric {
  return METRICS.find((metric) => metric === value) ?? "oee";
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
