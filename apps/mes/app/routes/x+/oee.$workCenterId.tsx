import { notFound } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import {
  Alert,
  AlertTitle,
  OeeShiftBoard,
  useInterval,
  useRealtimeChannel
} from "@carbon/react";
import { useCallback, useEffect, useRef } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { getWorkCenterHourlyOee } from "~/services/oee.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {});

  const { workCenterId } = params;
  if (!workCenterId) throw notFound("workCenterId not found");

  const url = new URL(request.url);
  const result = await getWorkCenterHourlyOee(client, {
    workCenterId,
    companyId,
    date: url.searchParams.get("date"),
    shiftId: url.searchParams.get("shiftId")
  });

  return { board: result.data, error: result.error, companyId };
}

const REALTIME_REFRESH_DEBOUNCE_MS = 10_000;

export default function WorkCenterOeeRoute() {
  const { board, error, companyId } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      revalidator.revalidate();
    }, REALTIME_REFRESH_DEBOUNCE_MS);
  }, [revalidator]);

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  useInterval(() => {
    revalidator.revalidate();
  }, 60_000);

  useRealtimeChannel({
    topic: `mes-oee-wc:${companyId}`,
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
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "workCenterDowntime",
            filter: `companyId=eq.${companyId}`
          },
          scheduleRefresh
        );
    }
  });

  if (!board) {
    return (
      <div className="p-4">
        <Alert variant="destructive">
          <AlertTitle>{error ?? "Failed to load OEE board"}</AlertTitle>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full p-4 h-[calc(100dvh-var(--header-height))] overflow-y-auto scrollbar-thin scrollbar-thumb-accent scrollbar-track-transparent">
      <OeeShiftBoard
        workCenterName={board.workCenter.name}
        status={board.status}
        shiftName={board.shift.name}
        window={board.window}
        timezone={board.timezone}
        currentJobs={board.currentJobs}
        cycleTimeMs={board.cycleTimeMs}
        hours={board.hours}
        totals={board.totals}
      />
    </div>
  );
}
