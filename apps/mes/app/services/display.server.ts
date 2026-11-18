// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

// Server-only reads of the work center displays. `display.service.ts` reaches
// the browser (components import it), so it never imports a `.server` module.

import { type Database, fetchAllByIds } from "@carbon/database";
import {
  buildOeeBoard,
  computeOeeParts,
  dayPeriods,
  estimateFinish,
  type Interval,
  oeeRatios,
  previousShiftWindow,
  shiftWindowAt,
  shownOee,
  splitAtShiftStarts
} from "@carbon/planning/oee";
import { loadOeeWorkCenters } from "@carbon/planning/oee/load.server";
import { fromAbsolute, toCalendarDate } from "@internationalized/date";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import {
  type OeeDisplayData,
  type OeeDisplayJob,
  orderQueue
} from "./display.service";

const DAY_MS = 24 * 3_600_000;
/** ETA pace never drops below this share of the standard speed (spec §3.7). */
const MIN_ETA_PACE = 0.3;
const JOB_LIST_SIZE = 4;

type OperationRow = {
  id: string;
  description: string | null;
  operationQuantity: number | null;
  quantityComplete: number | null;
  quantityScrapped: number | null;
  job: {
    jobId: string | null;
    item: { readableId: string | null; name: string | null } | null;
  } | null;
};

/**
 * The OEE line board of one work center: the current shift from its start to
 * now (between shifts, the shift that ended last). A work center that runs
 * around the clock, or has no shift, shows the current local day.
 */
export async function getOeeDisplayData(
  client: SupabaseClient<Database>,
  args: {
    workCenterId: string;
    companyId: string;
    locationId: string | null;
    loadedJobOperationId: string | null;
    timeZone: string;
    now: number;
  }
): Promise<{ data: OeeDisplayData | null; error: PostgrestError | null }> {
  const { now, timeZone } = args;
  const todayDate = toCalendarDate(fromAbsolute(now, timeZone)).toString();
  const today = dayPeriods(todayDate, todayDate, timeZone)[0]!.period;
  // Two days back, so the shift before a night shift is whole; two days on,
  // so the current shift's end and a job's finish are known.
  const loaded = await loadOeeWorkCenters(client, {
    companyId: args.companyId,
    workCenterIds: [args.workCenterId],
    from: today.start - 2 * DAY_MS,
    to: now,
    now,
    timeZone,
    windowsTo: now + 2 * DAY_MS
  });
  if (loaded.error) return { data: null, error: loaded.error };
  const workCenter = loaded.data[0];
  if (!workCenter) return { data: null, error: null };

  const windows = splitAtShiftStarts(
    workCenter.workingWindows,
    workCenter.shiftStarts
  );
  const shift: Interval =
    (workCenter.alwaysOn ? null : shiftWindowAt(windows, now)) ?? today;
  const previous = workCenter.alwaysOn
    ? { start: today.start - DAY_MS, end: today.start }
    : previousShiftWindow(windows, shift);

  const board = buildOeeBoard({
    input: workCenter.input,
    stateSegments: workCenter.stateSegments,
    shift,
    now
  });
  const previousShiftOee = previous
    ? shownOee(
        oeeRatios(computeOeeParts({ ...workCenter.input, period: previous }))
      )
    : null;

  // Only the loaded operation is the current job: a finished one is in the
  // job list, with no expected finish.
  const currentId = args.loadedJobOperationId;
  const operationIds = [
    ...new Set([
      ...board.jobs.map((job) => job.jobOperationId),
      ...(currentId ? [currentId] : [])
    ])
  ];
  const scrapReasonIds = board.scrap.flatMap((row) =>
    row.scrapReasonId ? [row.scrapReasonId] : []
  );

  const [operations, reasons, queue] = await Promise.all([
    fetchAllByIds<OperationRow>(operationIds, (batch) =>
      client
        .from("jobOperation")
        .select(
          "id, description, operationQuantity, quantityComplete, quantityScrapped, job:jobId(jobId, item:itemId(readableId, name))"
        )
        .eq("companyId", args.companyId)
        .in("id", batch)
        .order("id")
    ),
    fetchAllByIds<{ id: string; name: string }>(scrapReasonIds, (batch) =>
      client
        .from("scrapReason")
        .select("id, name")
        .eq("companyId", args.companyId)
        .in("id", batch)
        .order("id")
    ),
    args.locationId
      ? client.rpc("get_active_job_operations_by_location", {
          location_id: args.locationId,
          work_center_ids: [args.workCenterId]
        })
      : Promise.resolve({ data: [], error: null })
  ]);
  if (operations.error) return { data: null, error: operations.error };
  if (reasons.error) return { data: null, error: reasons.error };
  if (queue.error) return { data: null, error: queue.error };

  const operationById = new Map(
    (operations.data ?? []).map((row) => [row.id, row])
  );
  const jobView = (jobOperationId: string): OeeDisplayJob => {
    const operation = operationById.get(jobOperationId);
    const shiftJob = board.jobs.find(
      (job) => job.jobOperationId === jobOperationId
    );
    return {
      jobOperationId,
      jobReadableId: operation?.job?.jobId ?? null,
      itemReadableId: operation?.job?.item?.readableId ?? null,
      itemName: operation?.job?.item?.name ?? null,
      operationDescription: operation?.description ?? null,
      plannedQuantity: operation?.operationQuantity ?? null,
      completeQuantity: operation?.quantityComplete ?? 0,
      scrappedQuantity: operation?.quantityScrapped ?? 0,
      shiftPieces: shiftJob?.parts.totalPieces ?? 0,
      shiftBad: shiftJob?.parts.badPieces ?? 0,
      oee: shiftJob?.oee ?? null,
      plannedMs: shiftJob?.parts.plannedMs ?? 0
    };
  };

  let currentJob: OeeDisplayData["currentJob"] = null;
  if (currentId) {
    const view = jobView(currentId);
    const ideal =
      workCenter.input.idealByOperation.get(currentId) ??
      workCenter.input.deviceIdealSeconds;
    const remaining =
      view.plannedQuantity === null
        ? 0
        : Math.max(0, view.plannedQuantity - view.completeQuantity);
    const pace = Math.max(
      MIN_ETA_PACE,
      (board.ratios.availability ?? 1) * (board.ratios.performance ?? 1)
    );
    const eta =
      ideal === null || view.plannedQuantity === null
        ? null
        : estimateFinish({
            from: now,
            workMs: (remaining * ideal * 1000) / pace,
            windows: workCenter.input.plannedWindows
          });
    currentJob = {
      ...view,
      idealSecondsPerPiece: ideal,
      eta,
      etaAfterShift:
        ideal !== null &&
        view.plannedQuantity !== null &&
        (eta === null || eta > shift.end)
    };
  }

  const onScreen = new Set(operationIds);
  const next = orderQueue(
    (queue.data ?? []) as {
      id: string;
      operationStatus: string | null;
      operationDueDate: string | null;
      jobDueDate: string | null;
      jobReadableId: string | null;
      itemReadableId: string | null;
      itemDescription: string | null;
      operationQuantity: number | null;
    }[],
    onScreen
  )[0];

  return {
    data: {
      board,
      previousShiftOee,
      alwaysOn: workCenter.alwaysOn,
      source: workCenter.source,
      currentJob,
      jobs: board.jobs
        .slice(-JOB_LIST_SIZE)
        .map((job) => jobView(job.jobOperationId)),
      nextJob: next
        ? {
            jobReadableId: next.jobReadableId ?? null,
            itemReadableId: next.itemReadableId ?? null,
            itemName: next.itemDescription ?? null,
            plannedQuantity: next.operationQuantity ?? null
          }
        : null,
      scrapReasonNames: Object.fromEntries(
        (reasons.data ?? []).map((row) => [row.id, row.name])
      )
    },
    error: null
  };
}
