// SPDX-License-Identifier: LicenseRef-Carbon-Commercial
// Carbon Enterprise file, licensed only under the Carbon Commercial License
// (packages/ee/LICENSE). Not AGPL. Running, modifying, or copying it beyond those terms requires a commercial license.

import { posting } from "@carbon/api/postings.server";
import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import {
  lowerSensorProduction,
  removeSerialSensorCompletion,
  restoreSensorProduction,
  type SensorProductionChange
} from "@carbon/database/machine-counts";
import { getLogger } from "@carbon/logger";
import { RoundingMode, round } from "@carbon/utils";
import { sql } from "kysely";
import { machineTimeRefusal } from "./assignable";
import type { CountTracking } from "./counts";

const logger = getLogger("ee", "oee-counts");

/**
 * Posts the sensor's pending counts: each `Pending` `machineCountPosting` row
 * of a work center becomes the `productionQuantity` row the MES would write
 * for the same Log completed or Log scrap, through the same `issue` postings.
 *
 * - The note `Pulse sensor <row id>` on the `productionQuantity` row makes a
 *   retry find what an earlier attempt already posted, so nothing posts twice.
 * - A refusal (an error below 500) moves the row to Unattributed Counts with
 *   the refusal's words; any other error is retried on the next sync, and
 *   after `MAX_ATTEMPTS` the row goes to Unattributed Counts too.
 * - A Log scrap that lowers posted Production lowers it first, then posts the
 *   Scrap: the backflush issues for complete + scrapped units, so the other
 *   order would issue material twice for one piece. A failed Scrap puts the
 *   Production back.
 *
 * It never throws. It returns the tracked units whose label to print; the
 * caller prints them (`@carbon/printing/operation-label.server`).
 */

export const MAX_ATTEMPTS = 5;

export type MachineCountLabel = {
  trackedEntityId: string;
  jobOperationId: string;
  jobMakeMethodId: string | null;
  workCenterId: string;
};

/** The part of `quantity` the operation can still take before its target. */
export function splitAtTarget(args: {
  quantity: number;
  targetQuantity: number | null;
  quantityComplete: number;
  quantityReworked: number;
}): { post: number; over: number } {
  const { quantity, targetQuantity } = args;
  if (!targetQuantity || targetQuantity <= 0)
    return { post: quantity, over: 0 };
  const room = Math.max(
    0,
    targetQuantity - (args.quantityComplete + args.quantityReworked)
  );
  const post = Math.min(quantity, room);
  return { post, over: quantity - post };
}

/**
 * Which labels a batch completion prints: one each time the lot passes a
 * multiple of `labelEvery`, or one on the lot's first sensor completion when
 * `labelEvery` is not set.
 */
export function batchLabelCount(args: {
  before: number;
  after: number;
  labelEvery: number | null;
}): number {
  const { before, after, labelEvery } = args;
  if (!labelEvery || labelEvery <= 0) return before <= 0 && after > 0 ? 1 : 0;
  return Math.max(
    0,
    round(after / labelEvery, 0, RoundingMode.Down) -
      round(before / labelEvery, 0, RoundingMode.Down)
  );
}

type PendingRow = {
  id: string;
  workCenterId: string;
  jobOperationId: string;
  type: "Production" | "Scrap" | "Rework";
  quantity: number;
  reclassify: boolean;
  periodStart: string;
  periodEnd: string;
  attempts: number;
};

type OperationFacts = {
  status: string | null;
  jobStatus: string | null;
  targetQuantity: number | null;
  quantityComplete: number;
  quantityReworked: number;
  jobMakeMethodId: string | null;
  tracking: CountTracking;
};

type UnattributedReason =
  | "OperationClosed"
  | "OverTarget"
  | "NoScrapReason"
  | "Refused";

const note = (row: { id: string }) => `Pulse sensor ${row.id}`;

const iso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : value;

type PostMachineCountsArgs = {
  companyId: string;
  workCenterId: string;
  scrapReasonId: string | null;
  labelEveryQuantity: number | null;
};

/**
 * Posts one work center's pending counts, one poster at a time. The OEE sync
 * and an Unattributed Counts assign both post a work center's rows, and
 * without this lock both could read one row as `Pending` and post it twice.
 * The transaction advisory lock is held on its own connection while the
 * postings run on others, so no posting waits on it. A second poster waits,
 * then reads the rows the first one left `Pending`.
 */
export async function postMachineCounts(
  db: Kysely<KyselyDatabase>,
  args: PostMachineCountsArgs
): Promise<{ labels: MachineCountLabel[] }> {
  const key = `machineCountPost:${args.companyId}:${args.workCenterId}`;
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(
      trx
    );
    return postPendingCounts(db, args);
  });
}

async function postPendingCounts(
  db: Kysely<KyselyDatabase>,
  args: PostMachineCountsArgs
): Promise<{ labels: MachineCountLabel[] }> {
  const { companyId } = args;
  const handles = { db, companyId, userId: "system" };
  const labels: MachineCountLabel[] = [];

  let rows: PendingRow[];
  try {
    rows = (
      await db
        .selectFrom("machineCountPosting")
        .select([
          "id",
          "workCenterId",
          "jobOperationId",
          "type",
          "quantity",
          "reclassify",
          "periodStart",
          "periodEnd",
          "attempts"
        ])
        .where("companyId", "=", companyId)
        .where("workCenterId", "=", args.workCenterId)
        .where("status", "=", "Pending")
        .orderBy("createdAt")
        .orderBy("id")
        .execute()
    ).map((row) => ({
      ...row,
      quantity: Number(row.quantity),
      periodStart: iso(row.periodStart as Date | string),
      periodEnd: iso(row.periodEnd as Date | string)
    }));
  } catch (error) {
    logger.error("Failed to read pending machine counts", {
      companyId,
      workCenterId: args.workCenterId,
      error
    });
    return { labels };
  }

  /** Moves pieces of a row to Unattributed Counts and drops the row. */
  const toUnattributed = async (
    row: PendingRow,
    reason: UnattributedReason,
    quantity: number,
    detail: string | null = null
  ) => {
    await db.transaction().execute(async (trx) => {
      if (quantity > 0) {
        await trx
          .insertInto("unattributedMachineCount")
          .values({
            companyId,
            workCenterId: row.workCenterId,
            periodStart: row.periodStart,
            periodEnd: row.periodEnd,
            quantity: row.type === "Scrap" ? 0 : quantity,
            scrapQuantity: row.type === "Scrap" ? quantity : 0,
            reason,
            detail: detail?.slice(0, 500) ?? null,
            jobOperationId: row.jobOperationId,
            createdBy: "system"
          })
          .execute();
      }
      await trx
        .deleteFrom("machineCountPosting")
        .where("id", "=", row.id)
        .where("companyId", "=", companyId)
        .execute();
    });
  };

  const findPosted = async (row: PendingRow) =>
    db
      .selectFrom("productionQuantity")
      .select("id")
      .where("companyId", "=", companyId)
      .where("jobOperationId", "=", row.jobOperationId)
      .where("notes", "=", note(row))
      .executeTakeFirst();

  const markPosted = async (
    row: PendingRow,
    productionQuantityId: string | null,
    trackedEntityId: string | null = null
  ) => {
    const moved = await db
      .updateTable("machineCountPosting")
      .set({
        status: "Posted",
        productionQuantityId,
        ...(trackedEntityId ? { trackedEntityId } : {}),
        lastError: null,
        updatedBy: "system",
        updatedAt: sql`now()`
      })
      .where("id", "=", row.id)
      .where("companyId", "=", companyId)
      .where("status", "=", "Pending")
      .executeTakeFirst();
    if (Number(moved.numUpdatedRows) === 0) {
      logger.warning("Machine count was no longer pending when marked posted", {
        companyId,
        machineCountPostingId: row.id
      });
    }
  };

  /** A refusal goes to the queue; anything else waits for the next sync. */
  const failed = async (
    row: PendingRow,
    error: { message: string; status?: number }
  ) => {
    const refused = typeof error.status === "number" && error.status < 500;
    if (refused || row.attempts + 1 >= MAX_ATTEMPTS) {
      await toUnattributed(row, "Refused", row.quantity, error.message);
      return;
    }
    await db
      .updateTable("machineCountPosting")
      .set({
        attempts: row.attempts + 1,
        lastError: error.message.slice(0, 500),
        updatedBy: "system",
        updatedAt: sql`now()`
      })
      .where("id", "=", row.id)
      .where("companyId", "=", companyId)
      .execute();
  };

  const readOperation = async (
    jobOperationId: string
  ): Promise<OperationFacts | null> => {
    const operation = await db
      .selectFrom("jobOperation as o")
      .leftJoin("job as j", (join) =>
        join
          .onRef("j.id", "=", "o.jobId")
          .onRef("j.companyId", "=", "o.companyId")
      )
      .leftJoin("jobMakeMethod as m", "m.id", "o.jobMakeMethodId")
      .select([
        "o.status",
        "j.status as jobStatus",
        "o.targetQuantity",
        "o.quantityComplete",
        "o.quantityReworked",
        "o.jobMakeMethodId",
        "m.requiresSerialTracking",
        "m.requiresBatchTracking"
      ])
      .where("o.id", "=", jobOperationId)
      .where("o.companyId", "=", companyId)
      .executeTakeFirst();
    if (!operation) return null;
    return {
      status: operation.status,
      jobStatus: operation.jobStatus,
      targetQuantity:
        operation.targetQuantity === null
          ? null
          : Number(operation.targetQuantity),
      quantityComplete: Number(operation.quantityComplete ?? 0),
      quantityReworked: Number(operation.quantityReworked ?? 0),
      jobMakeMethodId: operation.jobMakeMethodId,
      tracking: operation.requiresSerialTracking
        ? "Serial"
        : operation.requiresBatchTracking
          ? "Batch"
          : "None"
    };
  };

  /** The make method's units, in the order the MES and the posting use. */
  const units = async (jobMakeMethodId: string) =>
    db
      .selectFrom("trackedEntity")
      .select(["id", "status", "quantity", "attributes"])
      .where("companyId", "=", companyId)
      .where(sql<string>`attributes->>'Job Make Method'`, "=", jobMakeMethodId)
      .orderBy("createdAt")
      .orderBy("readableId")
      .orderBy("id")
      .execute();

  /** The next unit the operation has not completed (the MES rule). */
  const nextIncompleteUnit = async (
    jobOperationId: string,
    jobMakeMethodId: string
  ): Promise<string | null> => {
    const [all, scope] = await Promise.all([
      units(jobMakeMethodId),
      db
        .selectFrom("jobOperationTrackedEntity")
        .select("trackedEntityId")
        .where("companyId", "=", companyId)
        .where("jobOperationId", "=", jobOperationId)
        .execute()
    ]);
    const inScope = new Set(scope.map((row) => row.trackedEntityId));
    const marker = `Operation ${jobOperationId}`;
    const next = all.find((unit) => {
      const attributes = (unit.attributes ?? {}) as Record<string, unknown>;
      return (
        (inScope.size === 0 || inScope.has(unit.id)) &&
        !(marker in attributes) &&
        unit.status !== "Consumed" &&
        unit.status !== "Scrapped"
      );
    });
    return next?.id ?? null;
  };

  const lotQuantity = async (jobOperationId: string) => {
    const result = await db
      .selectFrom("productionQuantity")
      .select(sql<string>`coalesce(sum(quantity), 0)`.as("total"))
      .where("companyId", "=", companyId)
      .where("jobOperationId", "=", jobOperationId)
      .where("type", "=", "Production")
      .executeTakeFirst();
    return Number(result?.total ?? 0);
  };

  for (const row of rows) {
    try {
      const operation = await readOperation(row.jobOperationId);
      if (
        !operation ||
        machineTimeRefusal(operation.status, operation.jobStatus) !== null
      ) {
        await toUnattributed(row, "OperationClosed", row.quantity);
        continue;
      }

      const already = await findPosted(row);
      if (already) {
        await markPosted(row, already.id);
        continue;
      }

      if (row.type === "Production") {
        const { post, over } = splitAtTarget({
          quantity: row.quantity,
          targetQuantity: operation.targetQuantity,
          quantityComplete: operation.quantityComplete,
          quantityReworked: operation.quantityReworked
        });
        if (post <= 0) {
          await toUnattributed(row, "OverTarget", row.quantity);
          continue;
        }
        if (over > 0) {
          // The pieces past the target are queued and the row keeps the
          // rest, in one transaction: a split left half done would hold the
          // same pieces in the queue and in the row.
          await db.transaction().execute(async (trx) => {
            await trx
              .insertInto("unattributedMachineCount")
              .values({
                companyId,
                workCenterId: row.workCenterId,
                periodStart: row.periodStart,
                periodEnd: row.periodEnd,
                quantity: over,
                scrapQuantity: 0,
                reason: "OverTarget",
                jobOperationId: row.jobOperationId,
                createdBy: "system"
              })
              .execute();
            await trx
              .updateTable("machineCountPosting")
              .set({
                quantity: post,
                updatedBy: "system",
                updatedAt: sql`now()`
              })
              .where("id", "=", row.id)
              .where("companyId", "=", companyId)
              .execute();
          });
          row.quantity = post;
        }
        await postProduction(row, operation);
      } else if (row.type === "Scrap") {
        if (!args.scrapReasonId) {
          await toUnattributed(row, "NoScrapReason", row.quantity);
          continue;
        }
        await postScrap(row, operation, args.scrapReasonId);
      }
    } catch (error) {
      logger.error("Failed to post a machine count", {
        companyId,
        machineCountPostingId: row.id,
        error
      });
      await failed(row, {
        message: error instanceof Error ? error.message : String(error)
      }).catch((inner) =>
        logger.error("Failed to record a machine count failure", {
          companyId,
          machineCountPostingId: row.id,
          error: inner
        })
      );
    }
  }

  return { labels };

  async function postProduction(row: PendingRow, operation: OperationFacts) {
    if (operation.tracking === "None") {
      const dryRun = await posting("issue", handles, {
        type: "jobOperationDryRun",
        id: row.jobOperationId,
        quantity: row.quantity
      });
      if (dryRun.error) return failed(row, dryRun.error);

      const inserted = await db.transaction().execute(async (trx) => {
        const productionQuantity = await trx
          .insertInto("productionQuantity")
          .values({
            companyId,
            jobOperationId: row.jobOperationId,
            type: "Production",
            quantity: row.quantity,
            notes: note(row),
            createdBy: "system"
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        const moved = await trx
          .updateTable("machineCountPosting")
          .set({
            status: "Posted",
            productionQuantityId: productionQuantity.id,
            lastError: null,
            updatedBy: "system",
            updatedAt: sql`now()`
          })
          .where("id", "=", row.id)
          .where("companyId", "=", companyId)
          .where("status", "=", "Pending")
          .executeTakeFirst();
        // Another poster moved the row: roll the insert back, or the pieces
        // would count twice.
        if (Number(moved.numUpdatedRows) === 0) {
          throw new Error("The machine count is no longer pending");
        }
        return productionQuantity;
      });

      // The backflush for the pieces, as the MES runs it after its insert.
      const issued = await posting("issue", handles, {
        type: "jobOperation",
        id: row.jobOperationId,
        quantity: row.quantity
      });
      if (issued.error) {
        logger.error("Failed to issue materials for sensor pieces", {
          companyId,
          productionQuantityId: inserted.id,
          error: issued.error.message
        });
      }
      return;
    }

    if (!operation.jobMakeMethodId) {
      return failed(row, {
        message: "The operation has no make method",
        status: 400
      });
    }

    if (operation.tracking === "Batch") {
      const lot = (await units(operation.jobMakeMethodId))[0];
      if (!lot) {
        return failed(row, {
          message: "The operation has no lot",
          status: 400
        });
      }
      const before = await lotQuantity(row.jobOperationId);
      const completed = await posting("issue", handles, {
        type: "jobOperationBatchComplete",
        trackedEntityId: lot.id,
        quantity: row.quantity,
        jobOperationId: row.jobOperationId,
        notes: note(row)
      });
      if (completed.error) return failed(row, completed.error);
      const posted = await findPosted(row);
      await markPosted(row, posted?.id ?? null, lot.id);
      const count = batchLabelCount({
        before,
        after: before + row.quantity,
        labelEvery: args.labelEveryQuantity
      });
      for (let i = 0; i < count; i++) {
        labels.push({
          trackedEntityId: lot.id,
          jobOperationId: row.jobOperationId,
          jobMakeMethodId: operation.jobMakeMethodId,
          workCenterId: row.workCenterId
        });
      }
      return;
    }

    // Serial: one unit per row (the planner gives a serial row quantity 1).
    const unit = await nextIncompleteUnit(
      row.jobOperationId,
      operation.jobMakeMethodId
    );
    if (!unit) {
      return failed(row, {
        message: "The operation has no unit left to complete",
        status: 400
      });
    }
    const completed = await posting("issue", handles, {
      type: "jobOperationSerialComplete",
      trackedEntityId: unit,
      quantity: 1,
      jobOperationId: row.jobOperationId,
      notes: note(row)
    });
    if (completed.error) return failed(row, completed.error);
    const posted = await findPosted(row);
    await markPosted(row, posted?.id ?? null, unit);
    labels.push({
      trackedEntityId: unit,
      jobOperationId: row.jobOperationId,
      jobMakeMethodId: operation.jobMakeMethodId,
      workCenterId: row.workCenterId
    });
  }

  async function postScrap(
    row: PendingRow,
    operation: OperationFacts,
    scrapReasonId: string
  ) {
    let changes: SensorProductionChange[] = [];
    let trackedEntityId: string | undefined;

    if (row.reclassify) {
      // Lower the posted Production first: see the file comment.
      const lowered = await db.transaction().execute(async (trx) =>
        operation.tracking === "Serial"
          ? removeSerialSensorCompletion(trx, {
              companyId,
              jobOperationId: row.jobOperationId,
              count: 1
            })
          : lowerSensorProduction(trx, {
              companyId,
              jobOperationId: row.jobOperationId,
              quantity: row.quantity,
              userId: "system"
            })
      );
      changes = lowered.changes;
      if ("trackedEntityIds" in lowered) {
        trackedEntityId = lowered.trackedEntityIds[0];
      }
    }

    if (operation.tracking === "Serial" && !trackedEntityId) {
      if (!operation.jobMakeMethodId) {
        return failed(row, {
          message: "The operation has no make method",
          status: 400
        });
      }
      trackedEntityId =
        (await nextIncompleteUnit(
          row.jobOperationId,
          operation.jobMakeMethodId
        )) ?? undefined;
      if (!trackedEntityId) {
        return failed(row, {
          message: "The operation has no unit to scrap",
          status: 400
        });
      }
    }

    const scrapped = await posting("issue", handles, {
      type: "jobOperationScrap",
      jobOperationId: row.jobOperationId,
      quantity: row.quantity,
      scrapReasonId,
      ...(trackedEntityId ? { trackedEntityId } : {}),
      notes: note(row)
    });
    if (scrapped.error) {
      if (changes.length > 0) {
        await db
          .transaction()
          .execute((trx) =>
            restoreSensorProduction(trx, { companyId, changes })
          );
      }
      return failed(row, scrapped.error);
    }
    const posted = await findPosted(row);
    await markPosted(row, posted?.id ?? null, trackedEntityId ?? null);
  }
}
