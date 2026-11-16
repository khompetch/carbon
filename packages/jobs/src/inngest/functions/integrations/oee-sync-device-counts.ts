// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import { lockWorkCenterDevice } from "@carbon/database/machine-time";
import {
  type CountOperation,
  type MachineCountPlan,
  planMachineCounts
} from "@carbon/ee/oee";
import type { MachineCountLabel } from "@carbon/ee/oee.server";
import { parseAbsolute } from "@internationalized/date";
import { sql } from "kysely";
import { readBlocks, readLoads, toInstant } from "./oee-sync-device";

/**
 * The count step of a device in count mode Auto: after the state sync, the
 * pulse buckets received since `countedThrough` become pending postings
 * (Log completed and Log scrap on the operation loaded when they were
 * counted) or Unattributed Counts, in one transaction under the device lock.
 * Then the poster posts the pending rows and the labels print.
 *
 * The cursor is `receivedAt`, not the bucket's period: the ingest service
 * writes one device's buckets in order, and a bucket replayed after a network
 * drop has an old period but a new `receivedAt`, so it is still read. Buckets
 * received in the last `SETTLE_SECONDS` wait, so a bucket still committing is
 * never skipped; the step then asks for a recheck just after they settle
 * (`recheckAt`), because ingest wakes the sync only once per bucket.
 */

export const SETTLE_SECONDS = 3;

export type CountDeviceScope = { workCenterId: string; companyId: string };

export type PostCounts = (
  db: Kysely<KyselyDatabase>,
  args: {
    companyId: string;
    workCenterId: string;
    scrapReasonId: string | null;
    labelEveryQuantity: number | null;
  }
) => Promise<{ labels: MachineCountLabel[] }>;

export type PrintLabel = (
  label: MachineCountLabel & { companyId: string }
) => Promise<void>;

export async function countOeeDevice({
  db,
  device,
  postCounts,
  printLabel
}: {
  db: Kysely<KyselyDatabase>;
  device: CountDeviceScope;
  postCounts: PostCounts;
  printLabel: PrintLabel;
}): Promise<{
  plan: MachineCountPlan;
  labels: number;
  /** When to run again for buckets too new to read this time. */
  recheckAt: string | null;
} | null> {
  const planned = await db.transaction().execute(async (trx) => {
    const locked = await lockWorkCenterDevice(trx, device);
    if (
      !locked ||
      locked.integration !== "pulse" ||
      locked.countMode !== "Auto"
    ) {
      return null;
    }

    const pulseDevice = await trx
      .selectFrom("pulseDevice")
      .select(["id", "piecesPerPulse", "sendEachPulse"])
      .where("companyId", "=", device.companyId)
      .where("deviceKey", "=", locked.externalDeviceId)
      .executeTakeFirst();
    if (!pulseDevice) return null;

    const { cutoff } = await sql<{ cutoff: Date | string }>`
      SELECT now() - make_interval(secs => ${SETTLE_SECONDS}) AS cutoff
    `
      .execute(trx)
      .then((result) => result.rows[0]!);

    let bucketQuery = trx
      .selectFrom("pulseCount")
      .select(["periodStart", "periodEnd", "pulses", "scrapPulses"])
      .where("companyId", "=", device.companyId)
      .where("pulseDeviceId", "=", pulseDevice.id)
      .where("receivedAt", "<=", toInstant(cutoff));
    if (locked.countedThrough !== null) {
      bucketQuery = bucketQuery.where(
        "receivedAt",
        ">",
        toInstant(locked.countedThrough)
      );
    }
    // Buckets already committed but inside the settle window: read next time.
    const { newest } = await trx
      .selectFrom("pulseCount")
      .select((eb) => eb.fn.max("receivedAt").as("newest"))
      .where("companyId", "=", device.companyId)
      .where("pulseDeviceId", "=", pulseDevice.id)
      .where("receivedAt", ">", toInstant(cutoff))
      .executeTakeFirstOrThrow();
    const recheckAt =
      newest === null
        ? null
        : parseAbsolute(toInstant(newest as Date | string), "UTC")
            .add({ seconds: SETTLE_SECONDS + 1 })
            .toAbsoluteString();

    const buckets = (
      await bucketQuery.orderBy("periodStart").orderBy("id").execute()
    ).map((row) => ({
      periodStart: toInstant(row.periodStart),
      periodEnd: toInstant(row.periodEnd),
      pulses: row.pulses,
      scrapPulses: row.scrapPulses
    }));

    let plan: MachineCountPlan = { postings: [], unattributed: [] };
    if (buckets.length > 0) {
      const from = buckets[0]!.periodStart;
      const [loads, blocks] = await Promise.all([
        readLoads(trx, device, from),
        readBlocks(trx, device, from)
      ]);
      const operationIds = [...new Set(loads.map((l) => l.jobOperationId))];
      const operations: CountOperation[] =
        operationIds.length === 0
          ? []
          : (
              await trx
                .selectFrom("jobOperation as o")
                .leftJoin("jobMakeMethod as m", "m.id", "o.jobMakeMethodId")
                .select([
                  "o.id",
                  "m.requiresSerialTracking",
                  "m.requiresBatchTracking"
                ])
                .where("o.companyId", "=", device.companyId)
                .where("o.id", "in", operationIds)
                .execute()
            ).map((row) => ({
              jobOperationId: row.id,
              tracking: row.requiresSerialTracking
                ? "Serial"
                : row.requiresBatchTracking
                  ? "Batch"
                  : "None"
            }));

      plan = planMachineCounts({
        buckets,
        loads,
        blocks,
        operations,
        piecesPerPulse: Number(pulseDevice.piecesPerPulse),
        sendEachPulse: pulseDevice.sendEachPulse,
        hasScrapReason: locked.scrapReasonId !== null
      });

      if (plan.postings.length > 0) {
        await trx
          .insertInto("machineCountPosting")
          .values(
            plan.postings.map((posting) => ({
              companyId: device.companyId,
              workCenterId: device.workCenterId,
              jobOperationId: posting.jobOperationId,
              type: posting.type,
              quantity: posting.quantity,
              reclassify: posting.reclassify,
              periodStart: posting.periodStart,
              periodEnd: posting.periodEnd,
              createdBy: "system"
            }))
          )
          .execute();
      }
      if (plan.unattributed.length > 0) {
        await trx
          .insertInto("unattributedMachineCount")
          .values(
            plan.unattributed.map((row) => ({
              companyId: device.companyId,
              workCenterId: device.workCenterId,
              periodStart: row.periodStart,
              periodEnd: row.periodEnd,
              quantity: row.quantity,
              scrapQuantity: row.scrapQuantity,
              reason: row.reason,
              jobOperationId: row.jobOperationId,
              createdBy: "system"
            }))
          )
          .execute();
      }
    }

    await trx
      .updateTable("workCenterDevice")
      .set({ countedThrough: toInstant(cutoff) })
      .where("id", "=", locked.id)
      .where("companyId", "=", device.companyId)
      .execute();

    return {
      plan,
      recheckAt,
      scrapReasonId: locked.scrapReasonId,
      labelEveryQuantity:
        locked.labelEveryQuantity === null
          ? null
          : Number(locked.labelEveryQuantity)
    };
  });

  if (!planned) return null;

  // Pending rows of earlier runs post too (a retry after a 5xx).
  const { labels } = await postCounts(db, {
    companyId: device.companyId,
    workCenterId: device.workCenterId,
    scrapReasonId: planned.scrapReasonId,
    labelEveryQuantity: planned.labelEveryQuantity
  });
  for (const label of labels) {
    await printLabel({ ...label, companyId: device.companyId });
  }
  return {
    plan: planned.plan,
    labels: labels.length,
    recheckAt: planned.recheckAt
  };
}
