import { error, notFound } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import {
  Button,
  OeeShiftBoard,
  useInterval,
  useRealtimeChannel
} from "@carbon/react";
import { msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useCallback, useEffect, useRef } from "react";
import { LuExpand } from "react-icons/lu";
import type { LoaderFunctionArgs } from "react-router";
import {
  Link,
  redirect,
  useLoaderData,
  useRevalidator,
  useSearchParams
} from "react-router";
import { useUser } from "~/hooks";
import { getWorkCenterHourlyOee } from "~/modules/production/production.server";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";

export const handle: Handle = {
  breadcrumb: msg`OEE`,
  to: path.to.productionOee
};

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "production"
  });

  const { workCenterId } = params;
  if (!workCenterId) throw notFound("workCenterId not found");

  const url = new URL(request.url);
  const result = await getWorkCenterHourlyOee(client, {
    workCenterId,
    companyId,
    date: url.searchParams.get("date"),
    shiftId: url.searchParams.get("shiftId")
  });

  if (result.error || !result.data) {
    throw redirect(
      path.to.productionOee,
      await flash(request, error(result.error, result.error ?? "Failed"))
    );
  }

  return result.data;
}

const REALTIME_REFRESH_DEBOUNCE_MS = 10_000;

export default function WorkCenterOeeRoute() {
  const board = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    company: { id: companyId }
  } = useUser();

  // Debounced realtime refresh + a slow safety-net poll for the TV use case
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
    topic: `production-oee-wc:${companyId}`,
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

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  };

  return (
    <div className="flex flex-col gap-3 w-full p-4 h-[calc(100dvh-var(--header-height))] overflow-y-auto scrollbar-thin scrollbar-thumb-rounded-full scrollbar-thumb-muted-foreground">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Button variant="secondary" asChild>
            <Link to={path.to.productionOee}>
              <Trans>Back to OEE</Trans>
            </Link>
          </Button>
          {board.shiftOptions.length > 1 && (
            <div className="flex items-center gap-1">
              {board.shiftOptions.map((shift) => (
                <Button
                  key={shift.id}
                  variant={
                    shift.id === board.shift.id ? "primary" : "secondary"
                  }
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.set("shiftId", shift.id);
                    next.set(
                      "date",
                      new Date(board.window.start).toISOString().slice(0, 10)
                    );
                    setSearchParams(next);
                  }}
                >
                  {shift.name}
                </Button>
              ))}
            </div>
          )}
        </div>
        <Button
          variant="secondary"
          leftIcon={<LuExpand />}
          onClick={toggleFullscreen}
        >
          <Trans>Fullscreen</Trans>
        </Button>
      </div>

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
