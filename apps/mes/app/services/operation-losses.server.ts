// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import type { Database } from "@carbon/database";
import { getCompanyTimeZone, getLocationTimeZone } from "@carbon/database";
import { getLogger } from "@carbon/logger";
import {
  type OeeLossCategory,
  operationSpeedLossMs
} from "@carbon/planning/oee";
import { loadOeeWorkCenters } from "@carbon/planning/oee/load.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getOperationStops,
  getStopReasonsList
} from "./operation-stops.service";

const log = getLogger("mes", "operation-losses");

export type OperationStopRow = {
  id: string;
  startTime: string;
  endTime: string | null;
  employeeId: string;
  notes: string | null;
  stopReasonId: string;
  reasonName: string;
  oeeLoss: OeeLossCategory;
};

export type OperationLossData = {
  stopReasons: { id: string; name: string; oeeLoss: OeeLossCategory }[];
  stops: OperationStopRow[];
  /** Scrap and Rework rows; `duringSetup` when logged while Setup ran. */
  rejects: { quantity: number; duringSetup: boolean }[];
  /** Null when the operation has no standard or never ran on a machine. */
  speedLossMs: number | null;
};

const EMPTY: OperationLossData = {
  stopReasons: [],
  stops: [],
  rejects: [],
  speedLossMs: null
};

/**
 * What the operation page needs for Log stop and the Six Big Losses. A part
 * that fails to load is logged and left empty, so the page still shows.
 */
export async function getOperationLossData(
  client: SupabaseClient<Database>,
  args: {
    companyId: string;
    jobOperationId: string;
    workCenterId: string | null;
    /** Epoch ms of the operation's first Machine event, if any. */
    firstMachineStart: number | null;
    now: number;
  }
): Promise<OperationLossData> {
  try {
    const [reasons, stops, rejects, speedLossMs] = await Promise.all([
      getStopReasonsList(client, args.companyId),
      getOperationStops(client, args),
      client
        .from("productionQuantity")
        .select("quantity, setupProductionEventId")
        .eq("companyId", args.companyId)
        .eq("jobOperationId", args.jobOperationId)
        .in("type", ["Scrap", "Rework"]),
      getSpeedLossMs(client, args)
    ]);

    for (const [part, result] of [
      ["stop reasons", reasons],
      ["stops", stops],
      ["rejects", rejects]
    ] as const) {
      if (result.error) {
        log.error("Failed to load operation loss data", {
          part,
          jobOperationId: args.jobOperationId,
          error: result.error
        });
      }
    }

    return {
      stopReasons: (reasons.data ?? []).map((reason) => ({
        id: reason.id,
        name: reason.name,
        oeeLoss: reason.oeeLoss as OeeLossCategory
      })),
      stops: (stops.data ?? []).map((stop) => {
        const reason = Array.isArray(stop.stopReason)
          ? stop.stopReason[0]
          : stop.stopReason;
        return {
          id: stop.id,
          startTime: stop.startTime,
          endTime: stop.endTime,
          employeeId: stop.employeeId,
          notes: stop.notes,
          stopReasonId: stop.stopReasonId,
          reasonName: reason?.name ?? "",
          oeeLoss: (reason?.oeeLoss ?? "Small Stop") as OeeLossCategory
        };
      }),
      rejects: (rejects.data ?? []).map((row) => ({
        quantity: Number(row.quantity ?? 0),
        duringSetup: row.setupProductionEventId !== null
      })),
      speedLossMs
    };
  } catch (error) {
    log.error("Failed to load operation loss data", {
      jobOperationId: args.jobOperationId,
      error
    });
    return EMPTY;
  }
}

async function getSpeedLossMs(
  client: SupabaseClient<Database>,
  args: {
    companyId: string;
    jobOperationId: string;
    workCenterId: string | null;
    firstMachineStart: number | null;
    now: number;
  }
): Promise<number | null> {
  if (!args.workCenterId || args.firstMachineStart === null) return null;

  const workCenter = await client
    .from("workCenter")
    .select("locationId")
    .eq("id", args.workCenterId)
    .eq("companyId", args.companyId)
    .maybeSingle();
  const locationId = workCenter.data?.locationId ?? null;
  const timeZone = locationId
    ? await getLocationTimeZone(client, locationId, args.companyId)
    : await getCompanyTimeZone(client, args.companyId);

  const loaded = await loadOeeWorkCenters(client, {
    companyId: args.companyId,
    workCenterIds: [args.workCenterId],
    from: args.firstMachineStart,
    to: args.now,
    now: args.now,
    timeZone
  });
  if (loaded.error) {
    log.error("Failed to load the operation's machine run", {
      jobOperationId: args.jobOperationId,
      error: loaded.error
    });
    return null;
  }
  const loadedWorkCenter = loaded.data[0];
  if (!loadedWorkCenter) return null;

  return operationSpeedLossMs(
    {
      ...loadedWorkCenter.input,
      period: { start: args.firstMachineStart, end: args.now }
    },
    args.jobOperationId
  );
}
