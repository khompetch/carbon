// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { notFound } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { getCompanyTimeZone, getLocationTimeZone } from "@carbon/database";
import { getLogger } from "@carbon/logger";
import {
  formatDurationMilliseconds,
  PERCENT_FORMAT,
  SCALE_FORMAT
} from "@carbon/utils";
import { now } from "@internationalized/date";
import { Trans, useLingui } from "@lingui/react/macro";
import { useLocale } from "@react-aria/i18n";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  type AnswerTone,
  DisplayFrame,
  Scoreboard,
  ScoreboardRow
} from "~/components/Display";
import { getOeeDisplayData } from "~/services/display.server";
import { getDisplayWorkCenter } from "~/services/display.service";
import { recordMeta } from "~/utils/meta";

const logger = getLogger("mes", "display");

/** OEE at or above this is good; below the second it is an alert. */
const GOOD_OEE = 0.85;
const LOW_OEE = 0.6;

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

  const oee = await getOeeDisplayData(serviceRole, {
    workCenterId,
    companyId,
    timeZone,
    now: now(timeZone).toDate().getTime()
  });
  if (oee.error) {
    logger.error("Failed to load the OEE display", {
      workCenterId,
      error: oee.error
    });
    throw new Error("Failed to load the OEE display");
  }

  return { workCenter, timeZone, oee: oee.data };
}

export default function OeeDisplayRoute() {
  const { t } = useLingui();
  const { locale } = useLocale();
  const { workCenter, timeZone, oee } = useLoaderData<typeof loader>();

  const percent = new Intl.NumberFormat(locale, PERCENT_FORMAT);
  const pieces = new Intl.NumberFormat(locale, SCALE_FORMAT);
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone
  });

  const ratios = oee?.ratios;
  const parts = oee?.parts;
  const ratio = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : percent.format(value);
  const duration = (ms: number | undefined) =>
    ms ? formatDurationMilliseconds(ms) : "—";

  const value = ratios?.oee ?? null;
  const isLow = value !== null && value < LOW_OEE;
  const good = parts
    ? parts.totalPieces - Math.min(parts.badPieces, parts.totalPieces)
    : 0;

  return (
    <DisplayFrame
      workCenterName={workCenter.name}
      title={<Trans>OEE</Trans>}
      status={isLow ? "alert" : "ok"}
      alertLabel={t`OEE is below ${percent.format(LOW_OEE)}`}
      okLabel={
        oee ? (
          <Trans>
            {time.format(oee.period.start)} – {time.format(oee.period.end)}
          </Trans>
        ) : (
          <Trans>No shift</Trans>
        )
      }
      refreshInterval={30_000}
    >
      <Scoreboard>
        <ScoreboardRow
          question={<Trans>OEE this shift</Trans>}
          answer={ratio(value)}
          tone={oeeTone(value)}
          emphasis={isLow}
        />
        <ScoreboardRow
          question={<Trans>Availability</Trans>}
          answer={ratio(ratios?.availability)}
        />
        <ScoreboardRow
          question={<Trans>Performance</Trans>}
          answer={ratio(ratios?.performance)}
        />
        <ScoreboardRow
          question={<Trans>Quality</Trans>}
          answer={ratio(ratios?.quality)}
        />
        <ScoreboardRow
          question={<Trans>Run time</Trans>}
          answer={duration(parts?.runMs)}
          detailLabel={<Trans>Planned</Trans>}
          detailValue={duration(parts?.plannedMs)}
          detailWide
        />
        <ScoreboardRow
          question={<Trans>Good pieces</Trans>}
          answer={pieces.format(good)}
        />
        <ScoreboardRow
          question={<Trans>Scrap</Trans>}
          answer={pieces.format(parts?.badPieces ?? 0)}
          tone={(parts?.badPieces ?? 0) > 0 ? "warn" : "neutral"}
        />
      </Scoreboard>
    </DisplayFrame>
  );
}

function oeeTone(value: number | null): AnswerTone {
  if (value === null) return "neutral";
  if (value >= GOOD_OEE) return "good";
  if (value >= LOW_OEE) return "warn";
  return "danger";
}
