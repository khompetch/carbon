// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { notFound } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { getCompanyTimeZone, getLocationTimeZone } from "@carbon/database";
import { getLogger } from "@carbon/logger";
import { OEE_LOW, oeeTone } from "@carbon/planning/oee";
import { PROGRESS_FORMAT } from "@carbon/utils";
import { now } from "@internationalized/date";
import { Trans, useLingui } from "@lingui/react/macro";
import { useLocale } from "@react-aria/i18n";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  DisplayFrame,
  OeeBoardHeaderDetail,
  OeeBoardView
} from "~/components/Display";
import { getOeeDisplayData } from "~/services/display.server";
import { getDisplayWorkCenter } from "~/services/display.service";
import { getOeeBoardAlerts } from "~/utils/display";
import { recordMeta } from "~/utils/meta";

const logger = getLogger("mes", "display");

export const meta: MetaFunction<typeof loader> = ({ data }) =>
  recordMeta(data?.workCenter?.name, "OEE Display");

export async function loader({ params, request }: LoaderFunctionArgs) {
  const { companyId } = await requirePermissions(request, {});
  const { workCenterId } = params;
  if (!workCenterId) throw notFound("workCenterId not found");

  const serviceRole = getCarbonServiceRole();

  // Tenancy gate: proves the work center belongs to this company before any
  // other service-role read runs.
  const workCenter = await getDisplayWorkCenter(serviceRole, {
    workCenterId,
    companyId
  });
  if (!workCenter) throw notFound("Work center not found");

  const timeZone = workCenter.locationId
    ? await getLocationTimeZone(serviceRole, workCenter.locationId, companyId)
    : await getCompanyTimeZone(serviceRole, companyId);

  const at = now(timeZone).toDate().getTime();
  const oee = await getOeeDisplayData(serviceRole, {
    workCenterId,
    companyId,
    locationId: workCenter.locationId,
    loadedJobOperationId: workCenter.loadedJobOperationId,
    timeZone,
    now: at
  });
  if (oee.error) {
    logger.error("Failed to load the OEE display", {
      workCenterId,
      error: oee.error
    });
    throw new Error("Failed to load the OEE display");
  }

  const board = oee.data;
  const job = board?.currentJob ?? null;
  const alerts = board
    ? getOeeBoardAlerts({
        now: at,
        shiftEnd: board.board.shift.end,
        current: board.board.current,
        isBlocked: workCenter.isBlocked,
        blockingDispatch: workCenter.blockingDispatchReadableId,
        performance: board.board.ratios.performance,
        oeeLow: OEE_LOW,
        currentJob: job
          ? {
              job: job.jobReadableId,
              oee: job.oee,
              plannedMs: job.plannedMs,
              eta: job.eta,
              remaining:
                job.plannedQuantity === null
                  ? 0
                  : job.plannedQuantity - job.completeQuantity
            }
          : null,
        nextJob: board.nextJob?.jobReadableId ?? null
      })
    : [];

  return { workCenter, timeZone, oee: board, alerts };
}

export default function OeeDisplayRoute() {
  const { t } = useLingui();
  const { locale } = useLocale();
  const low = new Intl.NumberFormat(locale, PROGRESS_FORMAT).format(OEE_LOW);
  const { workCenter, timeZone, oee, alerts } = useLoaderData<typeof loader>();

  const value = oee?.board.oee ?? null;
  const danger =
    oeeTone(value) === "danger" ||
    alerts.some((alert) => alert.severity === "danger");

  return (
    <DisplayFrame
      workCenterName={workCenter.name}
      title={<Trans>OEE</Trans>}
      status={danger ? "alert" : "ok"}
      alertLabel={
        oeeTone(value) === "danger"
          ? t`OEE is below ${low}`
          : t`Needs attention`
      }
      headerDetail={
        oee ? <OeeBoardHeaderDetail data={oee} timeZone={timeZone} /> : null
      }
      okLabel={oee ? null : <Trans>No shift</Trans>}
      refreshInterval={30_000}
    >
      {oee ? (
        <OeeBoardView
          data={oee}
          source={oee.source}
          alerts={alerts}
          timeZone={timeZone}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-white/55">
          <Trans>No shift and no data for this work center yet</Trans>
        </div>
      )}
    </DisplayFrame>
  );
}
