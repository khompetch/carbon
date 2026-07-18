import { error, getAppUrl, notFound } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { flash } from "@carbon/auth/session.server";
import {
  Button,
  DatePicker,
  OeeShiftBoard,
  toast,
  useInterval,
  useRealtimeChannel
} from "@carbon/react";
import { getLocalTimeZone, parseDate, today } from "@internationalized/date";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef } from "react";
import { LuExpand, LuLink } from "react-icons/lu";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Link,
  redirect,
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSearchParams
} from "react-router";
import { useUser } from "~/hooks";
import {
  getOrCreateWorkCenterShareLink,
  getWorkCenterHourlyOee
} from "~/modules/production/production.server";
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

export async function action({ request, params }: ActionFunctionArgs) {
  const { companyId } = await requirePermissions(request, {
    view: "production"
  });

  const { workCenterId } = params;
  if (!workCenterId) throw notFound("workCenterId not found");

  const link = await getOrCreateWorkCenterShareLink(getCarbonServiceRole(), {
    workCenterId,
    companyId
  });

  if (link.error || !link.data) {
    return { shareUrl: null };
  }

  return { shareUrl: `${getAppUrl()}${path.to.externalOee(link.data.id)}` };
}

const REALTIME_REFRESH_DEBOUNCE_MS = 10_000;
const REFRESH_INTERVAL_MS = 60_000;

export default function WorkCenterOeeRoute() {
  const { t } = useLingui();
  const board = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    company: { id: companyId }
  } = useUser();

  const shareFetcher = useFetcher<typeof action>();
  useEffect(() => {
    if (shareFetcher.state === "idle" && shareFetcher.data) {
      if (shareFetcher.data.shareUrl) {
        navigator.clipboard.writeText(shareFetcher.data.shareUrl);
        toast.success(t`Public TV link copied to clipboard`);
      } else {
        toast.error(t`Failed to create public link`);
      }
    }
  }, [shareFetcher.state, shareFetcher.data, t]);

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
  }, REFRESH_INTERVAL_MS);

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
          {/* Pick a past date to review that shift's board */}
          <div className="w-[168px]">
            <DatePicker
              aria-label={t`Shift date`}
              size="sm"
              closeOnSelect
              maxValue={today(getLocalTimeZone())}
              value={parseDate(
                new Date(board.window.start).toISOString().slice(0, 10)
              )}
              onChange={(date) => {
                if (!date) return;
                const next = new URLSearchParams(searchParams);
                next.set("date", date.toString());
                next.set("shiftId", board.shift.id);
                setSearchParams(next);
              }}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            leftIcon={<LuLink />}
            isLoading={shareFetcher.state !== "idle"}
            isDisabled={shareFetcher.state !== "idle"}
            onClick={() => {
              shareFetcher.submit(null, { method: "post" });
            }}
          >
            <Trans>Copy Public TV Link</Trans>
          </Button>
          <Button
            variant="secondary"
            leftIcon={<LuExpand />}
            onClick={toggleFullscreen}
          >
            <Trans>Fullscreen</Trans>
          </Button>
        </div>
      </div>

      <OeeShiftBoard
        workCenterName={board.workCenter.name}
        status={board.status}
        shiftName={board.shift.name}
        window={board.window}
        timezone={board.timezone}
        currentJobs={board.currentJobs}
        cycleTimeMs={board.cycleTimeMs}
        refreshIntervalMs={REFRESH_INTERVAL_MS}
        hours={board.hours}
        totals={board.totals}
      />
    </div>
  );
}
