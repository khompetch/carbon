// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { type Selectable, sql } from "kysely";
import type { KyselyDatabase, KyselyTx } from "./client";
import { EPSILON, round } from "./precision";

type ProductionQuantityRow = Selectable<KyselyDatabase["productionQuantity"]>;

/**
 * One `productionQuantity` row a sensor function changed: its quantity before
 * and after (0 = deleted), the row as it was read, and the posting that made
 * it, so `restoreSensorProduction` can put the row and the posting's link back.
 */
export type SensorProductionChange = {
  productionQuantityId: string;
  machineCountPostingId: string;
  before: number;
  after: number;
  row: ProductionQuantityRow;
};

async function lockJobOperation(
  trx: KyselyTx,
  args: { companyId: string; jobOperationId: string }
) {
  const operation = await trx
    .selectFrom("jobOperation")
    .select(["id", "jobMakeMethodId"])
    .where("id", "=", args.jobOperationId)
    .where("companyId", "=", args.companyId)
    .forUpdate()
    .executeTakeFirst();
  if (!operation) throw new Error("Job operation not found");
  return operation;
}

/**
 * The sensor's Posted Production rows of an operation that still have their
 * `productionQuantity` row, newest first.
 */
function sensorProductionRows(
  trx: KyselyTx,
  args: { companyId: string; jobOperationId: string }
) {
  return trx
    .selectFrom("machineCountPosting as mcp")
    .innerJoin("productionQuantity as pq", (join) =>
      join
        .onRef("pq.id", "=", "mcp.productionQuantityId")
        .onRef("pq.companyId", "=", "mcp.companyId")
    )
    .selectAll("pq")
    .select([
      "mcp.id as machineCountPostingId",
      "mcp.trackedEntityId as postingTrackedEntityId"
    ])
    .where("mcp.companyId", "=", args.companyId)
    .where("mcp.jobOperationId", "=", args.jobOperationId)
    .where("mcp.status", "=", "Posted")
    .where("mcp.type", "=", "Production")
    .where("mcp.productionQuantityId", "is not", null)
    .where("pq.companyId", "=", args.companyId)
    .orderBy("mcp.createdAt", "desc")
    .orderBy("mcp.id", "desc");
}

type SensorProductionRead = ProductionQuantityRow & {
  machineCountPostingId: string;
  postingTrackedEntityId: string | null;
};

function toChange(
  read: SensorProductionRead,
  after: number
): SensorProductionChange {
  const { machineCountPostingId, postingTrackedEntityId: _, ...row } = read;
  return {
    productionQuantityId: row.id,
    machineCountPostingId,
    before: Number(row.quantity),
    after,
    row
  };
}

/**
 * A batch operation's lot holds what the operation produced: set its quantity
 * to the sum of the operation's Production rows, as `produceBatchOutput`
 * (ERP inventory.service.ts) does. The lot is the job make method's tracked
 * entity; a Consumed lot is left alone.
 */
async function syncBatchLotQuantity(
  trx: KyselyTx,
  args: {
    companyId: string;
    jobOperationIds: string[];
  }
) {
  if (args.jobOperationIds.length === 0) return;
  await sql`
    UPDATE "trackedEntity" te
    SET "quantity" = totals."quantity"
    FROM (
      SELECT jmm."trackedEntityId",
             COALESCE(SUM(pq."quantity") FILTER (WHERE pq."type" = 'Production'), 0) AS "quantity"
      FROM "jobOperation" jo
      INNER JOIN "jobMakeMethod" jmm
        ON jmm."id" = jo."jobMakeMethodId" AND jmm."companyId" = jo."companyId"
      LEFT JOIN "productionQuantity" pq
        ON pq."jobOperationId" = jo."id" AND pq."companyId" = jo."companyId"
      WHERE jo."id" IN (${sql.join(args.jobOperationIds)})
        AND jo."companyId" = ${args.companyId}
        AND jmm."requiresBatchTracking" = TRUE
        AND jmm."trackedEntityId" IS NOT NULL
      GROUP BY jo."id", jmm."trackedEntityId"
    ) totals
    WHERE te."id" = totals."trackedEntityId"
      AND te."companyId" = ${args.companyId}
      AND te."status" <> 'Consumed'
  `.execute(trx);
}

/**
 * Lower the sensor's Production on an operation by `quantity` pieces: the
 * newest sensor rows first. A row that reaches 0 is deleted. The
 * `productionQuantity` interceptor moves `jobOperation.quantityComplete` with
 * each write. Returns what it lowered and the changes `restoreSensorProduction`
 * undoes.
 */
export async function lowerSensorProduction(
  trx: KyselyTx,
  args: {
    companyId: string;
    jobOperationId: string;
    quantity: number;
    userId: string;
  }
): Promise<{ lowered: number; changes: SensorProductionChange[] }> {
  await lockJobOperation(trx, args);
  const rows = await sensorProductionRows(trx, args).execute();

  let left = round(args.quantity);
  const changes: SensorProductionChange[] = [];
  for (const read of rows) {
    if (left <= EPSILON) break;
    const before = Number(read.quantity);
    const take = Math.min(before, left);
    const after = round(before - take);
    left = round(left - take);
    changes.push(toChange(read, after <= EPSILON ? 0 : after));
  }

  const deleted = changes.filter((c) => c.after === 0);
  const partial = changes.find((c) => c.after > 0);

  if (deleted.length > 0) {
    await trx
      .deleteFrom("productionQuantity")
      .where(
        "id",
        "in",
        deleted.map((c) => c.productionQuantityId)
      )
      .where("companyId", "=", args.companyId)
      .execute();
  }
  // Only the last row taken can be partial: one update at most.
  if (partial) {
    await trx
      .updateTable("productionQuantity")
      .set({
        quantity: partial.after,
        updatedBy: args.userId,
        updatedAt: sql`now()`
      })
      .where("id", "=", partial.productionQuantityId)
      .where("companyId", "=", args.companyId)
      .execute();
  }

  if (changes.length > 0) {
    await syncBatchLotQuantity(trx, {
      companyId: args.companyId,
      jobOperationIds: [args.jobOperationId]
    });
  }

  return {
    lowered: round(args.quantity - left),
    changes
  };
}

/**
 * Put back what `lowerSensorProduction` or `removeSerialSensorCompletion`
 * changed: a lowered row gets its quantity back, a deleted row is inserted
 * again with its old id and columns, and its posting points at it again.
 */
export async function restoreSensorProduction(
  trx: KyselyTx,
  args: { companyId: string; changes: SensorProductionChange[] }
): Promise<void> {
  if (args.changes.length === 0) return;
  const jobOperationIds = [
    ...new Set(args.changes.map((c) => c.row.jobOperationId))
  ].sort();
  await trx
    .selectFrom("jobOperation")
    .select("id")
    .where("id", "in", jobOperationIds)
    .where("companyId", "=", args.companyId)
    .orderBy("id")
    .forUpdate()
    .execute();

  const lowered = args.changes.filter((c) => c.after > 0);
  const deleted = args.changes.filter((c) => c.after === 0);

  if (lowered.length > 0) {
    const values = lowered.map((c) => ({
      id: c.productionQuantityId,
      quantity: c.before,
      updatedBy: c.row.updatedBy,
      updatedAt: c.row.updatedAt
    }));
    await sql`
      UPDATE "productionQuantity" pq
      SET "quantity" = v."quantity",
          "updatedBy" = v."updatedBy",
          "updatedAt" = v."updatedAt"
      FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb)
        AS v("id" TEXT, "quantity" NUMERIC, "updatedBy" TEXT, "updatedAt" TIMESTAMPTZ)
      WHERE pq."id" = v."id"
        AND pq."companyId" = ${args.companyId}
    `.execute(trx);
  }

  if (deleted.length > 0) {
    await trx
      .insertInto("productionQuantity")
      .values(
        deleted.map((c) => ({
          ...c.row,
          companyId: args.companyId,
          quantity: c.before
        }))
      )
      .execute();

    // The delete set the postings' link to null (ON DELETE SET NULL).
    const links = deleted.map((c) => ({
      id: c.machineCountPostingId,
      productionQuantityId: c.productionQuantityId
    }));
    await sql`
      UPDATE "machineCountPosting" mcp
      SET "productionQuantityId" = v."productionQuantityId"
      FROM jsonb_to_recordset(${JSON.stringify(links)}::jsonb)
        AS v("id" TEXT, "productionQuantityId" TEXT)
      WHERE mcp."id" = v."id"
        AND mcp."companyId" = ${args.companyId}
    `.execute(trx);
  }

  await syncBatchLotQuantity(trx, {
    companyId: args.companyId,
    jobOperationIds
  });
}

/**
 * Take back the newest `count` serial units the sensor completed on an
 * operation: delete the `productionQuantity` rows of its newest Posted
 * Production postings that name a unit. Returns the units, newest first, and
 * the changes `restoreSensorProduction` undoes.
 */
export async function removeSerialSensorCompletion(
  trx: KyselyTx,
  args: { companyId: string; jobOperationId: string; count: number }
): Promise<{ trackedEntityIds: string[]; changes: SensorProductionChange[] }> {
  await lockJobOperation(trx, args);
  if (args.count <= 0) return { trackedEntityIds: [], changes: [] };

  const rows = await sensorProductionRows(trx, args)
    .where("mcp.trackedEntityId", "is not", null)
    .limit(args.count)
    .execute();
  if (rows.length === 0) return { trackedEntityIds: [], changes: [] };

  await trx
    .deleteFrom("productionQuantity")
    .where(
      "id",
      "in",
      rows.map((row) => row.id)
    )
    .where("companyId", "=", args.companyId)
    .execute();

  return {
    trackedEntityIds: rows.map((row) => row.postingTrackedEntityId as string),
    changes: rows.map((row) => toChange(row, 0))
  };
}
