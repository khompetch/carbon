// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import type { Database } from "@carbon/database";
import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import {
  lockMachinePress,
  recordManualMachinePress
} from "@carbon/database/machine-time";
import { datetime, isJobLocked } from "@carbon/utils";
import type { SupabaseClient } from "@supabase/supabase-js";

export type OperationStopRefusal =
  | "not-found"
  | "already-stopped"
  | "not-stopped"
  | "reason-not-found";

class StopRefused extends Error {
  constructor(readonly reason: OperationStopRefusal) {
    super(reason);
  }
}

export async function getStopReasonsList(
  client: SupabaseClient<Database>,
  companyId: string
) {
  return client
    .from("stopReason")
    .select("id, name, oeeLoss")
    .eq("companyId", companyId)
    .eq("active", true)
    .order("name");
}

/** Every stop logged on an operation, oldest first, with its reason. */
export async function getOperationStops(
  client: SupabaseClient<Database>,
  args: { companyId: string; jobOperationId: string }
) {
  return client
    .from("operationStop")
    .select(
      "id, startTime, endTime, employeeId, notes, stopReasonId, stopReason(name, oeeLoss)"
    )
    .eq("companyId", args.companyId)
    .eq("jobOperationId", args.jobOperationId)
    .order("startTime");
}

/**
 * Logs a stop on an operation. On a work center the stop is a machine press:
 * it ends the work center's open machine time at the stop's start, and
 * remembers the operation's own Machine event so Resume can start it again.
 * Labor and Setup keep running. Skips RLS: the caller checks the permission.
 */
export async function startOperationStop(
  db: Kysely<KyselyDatabase>,
  args: {
    companyId: string;
    userId: string;
    jobOperationId: string;
    stopReasonId: string;
    notes?: string;
  }
): Promise<
  | { ok: true; stopId: string; endedEventIds: string[] }
  | { ok: false; reason: OperationStopRefusal }
> {
  try {
    return await db.transaction().execute(async (trx) => {
      const operation = await trx
        .selectFrom("jobOperation")
        .select(["id", "workCenterId"])
        .where("id", "=", args.jobOperationId)
        .where("companyId", "=", args.companyId)
        .executeTakeFirst();
      if (!operation) throw new StopRefused("not-found");

      const reason = await trx
        .selectFrom("stopReason")
        .select("id")
        .where("id", "=", args.stopReasonId)
        .where("companyId", "=", args.companyId)
        .where("active", "=", true)
        .executeTakeFirst();
      if (!reason) throw new StopRefused("reason-not-found");

      let startTime: string | undefined;
      let endedEventIds: string[] = [];
      let pausedMachineEventId: string | null = null;

      if (operation.workCenterId) {
        const press = { ...args, workCenterId: operation.workCenterId };
        await lockMachinePress(trx, press);
        const running = await trx
          .selectFrom("productionEvent")
          .select("id")
          .where("jobOperationId", "=", args.jobOperationId)
          .where("companyId", "=", args.companyId)
          .where("type", "=", "Machine")
          .where("endTime", "is", null)
          .orderBy("startTime", "desc")
          .executeTakeFirst();
        const result = await recordManualMachinePress(trx, press);
        startTime = result.pressedAt;
        endedEventIds = result.endedEventIds;
        if (running && endedEventIds.includes(running.id)) {
          pausedMachineEventId = running.id;
        }
      }

      const open = await trx
        .selectFrom("operationStop")
        .select("id")
        .where("jobOperationId", "=", args.jobOperationId)
        .where("companyId", "=", args.companyId)
        .where("endTime", "is", null)
        .executeTakeFirst();
      if (open) throw new StopRefused("already-stopped");

      const inserted = await trx
        .insertInto("operationStop")
        .values({
          companyId: args.companyId,
          jobOperationId: args.jobOperationId,
          workCenterId: operation.workCenterId,
          stopReasonId: args.stopReasonId,
          employeeId: args.userId,
          pausedMachineEventId,
          notes: args.notes || null,
          createdBy: args.userId,
          ...(startTime ? { startTime } : {})
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      return { ok: true as const, stopId: inserted.id, endedEventIds };
    });
  } catch (error) {
    if (error instanceof StopRefused)
      return { ok: false, reason: error.reason };
    throw error;
  }
}

/**
 * Ends an operation's open stop. When the stop paused a Machine event, a new
 * Machine event starts for the same operator, unless the operation is done
 * or its job is locked. Skips RLS: the caller checks the permission.
 */
export async function endOperationStop(
  db: Kysely<KyselyDatabase>,
  args: { companyId: string; userId: string; jobOperationId: string }
): Promise<
  | { ok: true; endedEventIds: string[]; resumedEventId: string | null }
  | { ok: false; reason: OperationStopRefusal }
> {
  try {
    return await db.transaction().execute(async (trx) => {
      const stop = await trx
        .selectFrom("operationStop")
        .select(["id", "workCenterId", "pausedMachineEventId"])
        .where("jobOperationId", "=", args.jobOperationId)
        .where("companyId", "=", args.companyId)
        .where("endTime", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!stop) throw new StopRefused("not-stopped");

      const paused = stop.pausedMachineEventId
        ? await trx
            .selectFrom("productionEvent")
            .innerJoin(
              "jobOperation",
              "jobOperation.id",
              "productionEvent.jobOperationId"
            )
            .innerJoin("job", "job.id", "jobOperation.jobId")
            .select([
              "productionEvent.employeeId",
              "productionEvent.workCenterId",
              "productionEvent.jobOperationBatchId",
              "jobOperation.status as operationStatus",
              "job.status as jobStatus"
            ])
            .where("productionEvent.id", "=", stop.pausedMachineEventId)
            .where("productionEvent.companyId", "=", args.companyId)
            .executeTakeFirst()
        : undefined;

      const resumable =
        paused?.workCenterId &&
        paused.operationStatus !== "Done" &&
        paused.operationStatus !== "Canceled" &&
        !isJobLocked(paused.jobStatus);

      let endedEventIds: string[] = [];
      let resumedEventId: string | null = null;
      let endTime: string | undefined;

      if (resumable && paused?.workCenterId) {
        const press = await recordManualMachinePress(trx, {
          companyId: args.companyId,
          userId: args.userId,
          workCenterId: paused.workCenterId
        });
        endTime = press.pressedAt;
        endedEventIds = press.endedEventIds;
        const inserted = await trx
          .insertInto("productionEvent")
          .values({
            jobOperationId: args.jobOperationId,
            type: "Machine",
            employeeId: paused.employeeId,
            workCenterId: paused.workCenterId,
            jobOperationBatchId: paused.jobOperationBatchId,
            startTime: press.pressedAt,
            companyId: args.companyId,
            createdBy: args.userId
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        resumedEventId = inserted.id;
      }

      await trx
        .updateTable("operationStop")
        .set({
          endTime: endTime ?? datetime.timestamp(),
          updatedBy: args.userId,
          updatedAt: datetime.timestamp()
        })
        .where("id", "=", stop.id)
        .where("companyId", "=", args.companyId)
        .execute();

      return { ok: true as const, endedEventIds, resumedEventId };
    });
  } catch (error) {
    if (error instanceof StopRefused)
      return { ok: false, reason: error.reason };
    throw error;
  }
}
