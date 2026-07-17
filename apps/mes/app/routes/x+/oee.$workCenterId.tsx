import { notFound } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { getCarbonServiceRole } from "@carbon/auth/client.server";
import {
  Alert,
  AlertTitle,
  Button,
  OeeShiftBoard,
  toast,
  useInterval,
  useRealtimeChannel
} from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef } from "react";
import { LuLink } from "react-icons/lu";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import {
  getOrCreateWorkCenterShareLink,
  getWorkCenterHourlyOee
} from "~/services/oee.server";
import { ERP_URL } from "~/utils/path";

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

export async function action({ request, params }: ActionFunctionArgs) {
  const { companyId } = await requirePermissions(request, {});

  const { workCenterId } = params;
  if (!workCenterId) throw notFound("workCenterId not found");

  const link = await getOrCreateWorkCenterShareLink(getCarbonServiceRole(), {
    workCenterId,
    companyId
  });

  if (link.error || !link.data) {
    return { shareUrl: null };
  }

  // The public board page lives in the ERP app's share+ routes
  return { shareUrl: `${ERP_URL}/share/oee/${link.data.id}` };
}

const REALTIME_REFRESH_DEBOUNCE_MS = 10_000;
const REFRESH_INTERVAL_MS = 60_000;

export default function WorkCenterOeeRoute() {
  const { t } = useLingui();
  const { board, error, companyId } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

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
    <div className="flex flex-col gap-3 w-full p-4 h-[calc(100dvh-var(--header-height))] overflow-y-auto scrollbar-thin scrollbar-thumb-accent scrollbar-track-transparent">
      <div className="flex justify-end">
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
