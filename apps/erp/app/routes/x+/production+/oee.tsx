import { requirePermissions } from "@carbon/auth/auth.server";
import {
  Button,
  Card,
  CardAction,
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
  PulsingDot,
  ToggleGroup,
  ToggleGroupItem,
  useRealtimeChannel
} from "@carbon/react";
import { now, toCalendarDateTime } from "@internationalized/date";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { DateRange } from "@react-types/datepicker";
import { useCallback, useEffect, useRef, useState } from "react";
import { LuChevronDown } from "react-icons/lu";
import type { LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { DateSelect, Empty } from "~/components";
import { useUser } from "~/hooks/useUser";
import {
  OeeGroupChart,
  OeeStatCards,
  OeeTable,
  ScrapParetoChart
} from "~/modules/production/ui/Oee";
import type { loader as oeeLoader } from "~/routes/api+/production.oee";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";

export const handle: Handle = {
  breadcrumb: msg`OEE`,
  to: path.to.productionOee,
  module: "production"
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "production"
  });

  const locations = await client
    .from("location")
    .select("id, name")
    .eq("companyId", companyId)
    .order("name");

  return { locations: locations.data ?? [] };
}

const REALTIME_REFRESH_DEBOUNCE_MS = 10_000;

export default function OeeDashboard() {
  const { t } = useLingui();
  const { locations } = useLoaderData<typeof loader>();
  const {
    company: { id: companyId }
  } = useUser();

  const oeeFetcher = useFetcher<typeof oeeLoader>();
  const isFetching = oeeFetcher.state !== "idle" || !oeeFetcher.data;

  const [interval, setInterval] = useState("month");
  const [groupBy, setGroupBy] = useState<"workCenter" | "process">(
    "workCenter"
  );
  const [locationId, setLocationId] = useState<string>("");
  const [dateRange, setDateRange] = useState<DateRange | null>(() => {
    const end = toCalendarDateTime(now("UTC"));
    const start = end.add({ months: -1 });
    return { start, end };
  });

  // oeeFetcher identity changes on every fetch; excluding it is the same
  // convention the production dashboard uses for its kpiFetcher.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetcher excluded intentionally
  const loadOee = useCallback(() => {
    if (!dateRange) return;
    const params = new URLSearchParams({
      start: dateRange.start.toString(),
      end: dateRange.end.toString(),
      groupBy
    });
    if (locationId) params.set("locationId", locationId);
    oeeFetcher.load(`${path.to.api.productionOee}?${params.toString()}`);
  }, [dateRange, groupBy, locationId]);

  useEffect(() => {
    loadOee();
  }, [loadOee]);

  // ── Realtime: refresh (debounced) while the range includes the present ─────
  const rangeIncludesNow =
    dateRange !== null &&
    dateRange.end.compare(toCalendarDateTime(now("UTC"))) >= 0;

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadOeeRef = useRef(loadOee);
  loadOeeRef.current = loadOee;
  const rangeIncludesNowRef = useRef(rangeIncludesNow);
  rangeIncludesNowRef.current = rangeIncludesNow;

  const scheduleRefresh = useCallback(() => {
    if (!rangeIncludesNowRef.current || refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      loadOeeRef.current();
    }, REALTIME_REFRESH_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  useRealtimeChannel({
    topic: `production-oee:${companyId}`,
    setup(channel) {
      return channel
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "productionEvent",
            filter: `companyId=eq.${companyId}`
          },
          scheduleRefresh
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "productionQuantity",
            filter: `companyId=eq.${companyId}`
          },
          scheduleRefresh
        );
    }
  });

  const selectedLocation = locations.find((l) => l.id === locationId);
  const groups = oeeFetcher.data?.groups ?? [];
  const scrapPareto = oeeFetcher.data?.scrapPareto ?? [];
  const hasData = groups.length > 0;

  return (
    <div className="flex flex-col gap-4 w-full p-4 h-[calc(100dvh-var(--header-height))] overflow-y-auto scrollbar-thin scrollbar-thumb-rounded-full scrollbar-thumb-muted-foreground">
      <HStack className="justify-between w-full flex-wrap gap-2">
        <HStack className="gap-2">
          <ToggleGroup
            type="single"
            value={groupBy}
            onValueChange={(value) => {
              if (value) setGroupBy(value as "workCenter" | "process");
            }}
          >
            <ToggleGroupItem value="workCenter" aria-label={t`Work Center`}>
              <Trans>Work Center</Trans>
            </ToggleGroupItem>
            <ToggleGroupItem value="process" aria-label={t`Process`}>
              <Trans>Process</Trans>
            </ToggleGroupItem>
          </ToggleGroup>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" rightIcon={<LuChevronDown />}>
                {selectedLocation?.name ?? t`All Locations`}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="start">
              <DropdownMenuRadioGroup
                value={locationId}
                onValueChange={setLocationId}
              >
                <DropdownMenuRadioItem value="">
                  <Trans>All Locations</Trans>
                </DropdownMenuRadioItem>
                {locations.map((location) => (
                  <DropdownMenuRadioItem key={location.id} value={location.id}>
                    {location.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </HStack>
        <HStack className="gap-2 items-center">
          {rangeIncludesNow && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <PulsingDot />
              <Trans>Live</Trans>
            </div>
          )}
          <DateSelect
            value={interval}
            onValueChange={(value) => {
              const end = toCalendarDateTime(now("UTC"));
              if (value === "week") {
                setDateRange({ start: end.add({ days: -7 }), end });
              } else if (value === "month") {
                setDateRange({ start: end.add({ months: -1 }), end });
              } else if (value === "quarter") {
                setDateRange({ start: end.add({ months: -3 }), end });
              } else if (value === "year") {
                setDateRange({ start: end.add({ years: -1 }), end });
              }
              setInterval(value);
            }}
            dateRange={dateRange}
            onDateRangeChange={setDateRange}
          />
        </HStack>
      </HStack>

      <OeeStatCards
        totals={oeeFetcher.data?.totals}
        previousTotals={oeeFetcher.data?.previousTotals}
        isLoading={isFetching}
      />

      <Card>
        <CardHeader>
          <CardTitle>
            {groupBy === "process" ? (
              <Trans>OEE by Process</Trans>
            ) : (
              <Trans>OEE by Work Center</Trans>
            )}
          </CardTitle>
          <CardAction />
        </CardHeader>
        <CardContent className="min-h-[240px] flex-col gap-4">
          {oeeFetcher.state === "idle" && !hasData ? (
            <div className="flex flex-col items-center justify-center h-full">
              <Empty className="py-8">
                <p className="text-sm text-muted-foreground">
                  <Trans>No production data within range</Trans>
                </p>
              </Empty>
            </div>
          ) : (
            <Loading isLoading={isFetching} className="w-full">
              <OeeGroupChart groups={groups} />
            </Loading>
          )}
        </CardContent>
      </Card>

      {hasData && (
        <Card>
          <CardHeader>
            <CardTitle>
              <Trans>Details</Trans>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <OeeTable groups={groups} />
          </CardContent>
        </Card>
      )}

      {scrapPareto.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              <Trans>Scrap by Reason</Trans>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrapParetoChart data={scrapPareto} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
