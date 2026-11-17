// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { requirePermissions } from "@carbon/auth/auth.server";
import { getLocationTimeZone } from "@carbon/database";
import { getLogger } from "@carbon/logger";
import {
  addOeeParts,
  computeOeeParts,
  dayPeriods,
  EMPTY_OEE_PARTS,
  type OeeParts,
  type OeeRatios,
  oeeRatios
} from "@carbon/planning/oee";
import { loadOeeWorkCenters } from "@carbon/planning/oee/load.server";
import { now, parseDate } from "@internationalized/date";
import type { LoaderFunctionArgs } from "react-router";

/** The longest range the OEE page reads (spec: 92 days). */
const MAX_DAYS = 92;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const logger = getLogger("erp", "production");

export type OeeWorkCenterRow = {
  id: string;
  name: string;
  source: "Sensor" | "Operator";
  parts: OeeParts;
  ratios: OeeRatios;
};

export type OeeDayRow = { day: string; parts: OeeParts; ratios: OeeRatios };

export type OeeResponse = {
  timeZone: string | null;
  workCenters: OeeWorkCenterRow[];
  days: OeeDayRow[];
  totals: { parts: OeeParts; ratios: OeeRatios } | null;
};

const empty: OeeResponse = {
  timeZone: null,
  workCenters: [],
  days: [],
  totals: null
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "production"
  });
  const searchParams = new URL(request.url).searchParams;
  const locationId = searchParams.get("locationId");
  const start = searchParams.get("start") ?? "";
  const end = searchParams.get("end") ?? "";
  if (!locationId || !DATE.test(start) || !DATE.test(end)) return empty;

  const startDate = parseDate(start);
  const endDate = parseDate(end);
  const length = endDate.compare(startDate) + 1;
  if (length < 1 || length > MAX_DAYS) return empty;

  const [timeZone, workCenters] = await Promise.all([
    getLocationTimeZone(client, locationId, companyId),
    client
      .from("workCenter")
      .select("id, name")
      .eq("companyId", companyId)
      .eq("locationId", locationId)
      .eq("active", true)
      .order("name")
  ]);
  if (workCenters.error) {
    logger.error("Failed to load the OEE work centers", {
      locationId,
      error: workCenters.error
    });
    throw new Error("Failed to load the OEE work centers");
  }

  const days = dayPeriods(start, end, timeZone);
  const nowMs = now(timeZone).toDate().getTime();

  const loaded = await loadOeeWorkCenters(client, {
    companyId,
    workCenterIds: (workCenters.data ?? []).map((wc) => wc.id),
    from: days[0]!.period.start,
    to: days[days.length - 1]!.period.end,
    now: nowMs,
    timeZone
  });
  if (loaded.error) {
    logger.error("Failed to load the OEE data", {
      locationId,
      error: loaded.error
    });
    throw new Error("Failed to load the OEE data");
  }

  const names = new Map((workCenters.data ?? []).map((wc) => [wc.id, wc.name]));
  const dayParts = days.map(() => ({ ...EMPTY_OEE_PARTS }));

  const rows: OeeWorkCenterRow[] = loaded.data.map((workCenter) => {
    let parts = { ...EMPTY_OEE_PARTS };
    days.forEach((day, index) => {
      const dayResult = computeOeeParts({
        ...workCenter.input,
        period: day.period
      });
      parts = addOeeParts(parts, dayResult);
      dayParts[index] = addOeeParts(dayParts[index]!, dayResult);
    });
    return {
      id: workCenter.workCenterId,
      name: names.get(workCenter.workCenterId) ?? workCenter.workCenterId,
      source: workCenter.source,
      parts,
      ratios: oeeRatios(parts)
    };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const total = rows.reduce(
    (sum, row) => addOeeParts(sum, row.parts),
    EMPTY_OEE_PARTS
  );

  return {
    timeZone,
    workCenters: rows,
    days: days.map((day, index) => ({
      day: day.day,
      parts: dayParts[index]!,
      ratios: oeeRatios(dayParts[index]!)
    })),
    totals: { parts: total, ratios: oeeRatios(total) }
  } satisfies OeeResponse;
}
