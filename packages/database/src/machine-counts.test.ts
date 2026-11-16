// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { randomUUID } from "node:crypto";
import type { DatabaseConnection } from "kysely";
import { CompiledQuery, Kysely, PostgresDialect, PostgresDriver } from "kysely";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { KyselyDatabase } from "./client.ts";
import {
  lowerSensorProduction,
  removeSerialSensorCompletion,
  restoreSensorProduction
} from "./machine-counts.ts";

// Runs against the local database, like machine-time.test.ts:
//   SUPABASE_DB_URL=… pnpm --filter @carbon/database exec vitest run src/machine-counts.test.ts
//
// Each test runs inside one transaction that is always rolled back.
const url = process.env.SUPABASE_DB_URL;

class SavepointDriver extends PostgresDriver {
  override async beginTransaction(connection: DatabaseConnection) {
    await connection.executeQuery(CompiledQuery.raw("SAVEPOINT engine"));
  }
  override async commitTransaction(connection: DatabaseConnection) {
    await connection.executeQuery(
      CompiledQuery.raw("RELEASE SAVEPOINT engine")
    );
  }
  override async rollbackTransaction(connection: DatabaseConnection) {
    await connection.executeQuery(
      CompiledQuery.raw("ROLLBACK TO SAVEPOINT engine")
    );
  }
}

type Row = Record<string, unknown>;

describe.skipIf(!url)("machine counts against a migrated database", () => {
  const client = new Client({ connectionString: url });
  const config = {
    pool: {
      connect: async () => Object.assign(client, { release: () => undefined }),
      end: async () => undefined
    }
  };
  const dialect = new PostgresDialect(config);
  const db = new Kysely<KyselyDatabase>({
    dialect: {
      createAdapter: () => dialect.createAdapter(),
      createDriver: () => new SavepointDriver(config),
      createIntrospector: (k) => dialect.createIntrospector(k),
      createQueryCompiler: () => dialect.createQueryCompiler()
    }
  });

  const run = randomUUID().slice(0, 8);
  const id = (name: string) => `t-${run}-${name}`;
  const companyId = id("company");
  const jobOperationId = id("op");
  const lotId = id("lot");
  const userId = "system";

  async function insert(table: string, given: Row) {
    const row: Row = { companyId, createdBy: "system", ...given };
    const columns = Object.keys(row);
    await client.query(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(row)
    );
  }

  /**
   * One operation, and one sensor posting per entry, oldest first. The rows
   * the operation points at go in with triggers and FKs off; the operation's
   * production rows and postings go in with them on, so the interceptor moves
   * jobOperation.quantityComplete as in production. The make method is a
   * subassembly's, so the interceptor leaves the (bare) job row alone.
   */
  async function seed(
    postings: { name: string; quantity: number; unit?: string }[],
    options: { batch?: boolean } = {}
  ) {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO "company" ("id", "name", "baseCurrencyCode") VALUES ($1, 'Test', 'USD')`,
      [companyId]
    );
    await insert("job", {
      id: id("job"),
      jobId: id("job"),
      itemId: id("item"),
      unitOfMeasureCode: "EA",
      locationId: id("location")
    });
    await insert("process", {
      id: id("process"),
      name: "Press",
      defaultStandardFactor: "Minutes/Piece"
    });
    await insert("workCenter", { id: id("wc"), name: "Press 1" });
    await insert("jobMakeMethod", {
      id: id("jmm"),
      jobId: id("job"),
      itemId: id("item"),
      parentMaterialId: id("material"),
      requiresBatchTracking: options.batch ?? false,
      trackedEntityId: options.batch ? lotId : null
    });
    await insert("jobOperation", {
      id: jobOperationId,
      jobId: id("job"),
      jobMakeMethodId: id("jmm"),
      processId: id("process"),
      status: "In Progress",
      targetQuantity: 100
    });
    const units = postings.flatMap((p) => (p.unit ? [id(p.unit)] : []));
    for (const unit of options.batch ? [...units, lotId] : units) {
      await insert("trackedEntity", {
        id: unit,
        quantity: 0,
        status: "Available",
        sourceDocument: "Item",
        sourceDocumentId: id("item")
      });
    }

    await client.query("SET LOCAL session_replication_role = origin");
    for (const [i, posting] of postings.entries()) {
      await insert("productionQuantity", {
        id: id(posting.name),
        jobOperationId,
        type: "Production",
        quantity: posting.quantity,
        createdAt: `2026-11-16T08:0${i}:00Z`
      });
      await insert("machineCountPosting", {
        id: id(`mcp-${posting.name}`),
        workCenterId: id("wc"),
        jobOperationId,
        type: "Production",
        quantity: posting.quantity,
        periodStart: `2026-11-16T08:0${i}:00Z`,
        periodEnd: `2026-11-16T08:0${i}:05Z`,
        status: "Posted",
        trackedEntityId: posting.unit ? id(posting.unit) : null,
        productionQuantityId: id(posting.name),
        createdAt: `2026-11-16T08:0${i}:05Z`
      });
    }
  }

  async function quantities() {
    const pq = await client.query(
      `SELECT "id", "quantity"::float AS "quantity" FROM "productionQuantity"
       WHERE "jobOperationId" = $1 ORDER BY "id"`,
      [jobOperationId]
    );
    const op = await client.query(
      `SELECT "quantityComplete"::float AS "complete" FROM "jobOperation" WHERE "id" = $1`,
      [jobOperationId]
    );
    return {
      rows: Object.fromEntries(
        pq.rows.map((r) => [String(r.id).replace(`t-${run}-`, ""), r.quantity])
      ),
      complete: op.rows[0].complete as number
    };
  }

  async function postingLink(name: string) {
    const result = await client.query(
      `SELECT "productionQuantityId" FROM "machineCountPosting" WHERE "id" = $1`,
      [id(`mcp-${name}`)]
    );
    return result.rows[0].productionQuantityId as string | null;
  }

  async function lotQuantity() {
    const result = await client.query(
      `SELECT "quantity"::float AS "quantity" FROM "trackedEntity" WHERE "id" = $1`,
      [lotId]
    );
    return result.rows[0].quantity as number;
  }

  const lower = (quantity: number) =>
    db
      .transaction()
      .execute((trx) =>
        lowerSensorProduction(trx, {
          companyId,
          jobOperationId,
          quantity,
          userId
        })
      );

  beforeAll(async () => {
    await client.connect();
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  afterAll(async () => {
    await client.end();
  });

  it("lowers the newest sensor rows first and deletes a row that reaches 0", async () => {
    await seed([
      { name: "a", quantity: 5 },
      { name: "b", quantity: 3 }
    ]);

    const result = await lower(6);

    expect(result.lowered).toBe(6);
    expect(
      result.changes.map((c) => [c.productionQuantityId, c.before, c.after])
    ).toEqual([
      [id("b"), 3, 0],
      [id("a"), 5, 2]
    ]);
    expect(await quantities()).toEqual({ rows: { a: 2 }, complete: 2 });
  });

  it("lowers no more than the sensor posted and leaves an operator's row", async () => {
    await seed([
      { name: "a", quantity: 5 },
      { name: "b", quantity: 3 }
    ]);
    await insert("productionQuantity", {
      id: id("operator-row"),
      jobOperationId,
      type: "Production",
      quantity: 4
    });

    const result = await lower(10);

    expect(result.lowered).toBe(8);
    expect(await quantities()).toEqual({
      rows: { "operator-row": 4 },
      complete: 4
    });
  });

  it("restores the rows, the posting links and the batch lot", async () => {
    await seed(
      [
        { name: "a", quantity: 5 },
        { name: "b", quantity: 3 }
      ],
      { batch: true }
    );

    const { changes } = await lower(6);
    expect(await lotQuantity()).toBe(2);
    expect(await postingLink("b")).toBeNull();

    await db
      .transaction()
      .execute((trx) => restoreSensorProduction(trx, { companyId, changes }));

    expect(await quantities()).toEqual({ rows: { a: 5, b: 3 }, complete: 8 });
    expect(await postingLink("b")).toBe(id("b"));
    expect(await lotQuantity()).toBe(8);
  });

  it("removes the newest serial units the sensor completed", async () => {
    await seed([
      { name: "s1", quantity: 1, unit: "unit-1" },
      { name: "s2", quantity: 1, unit: "unit-2" },
      { name: "s3", quantity: 1, unit: "unit-3" },
      { name: "plain", quantity: 1 }
    ]);

    const result = await db.transaction().execute((trx) =>
      removeSerialSensorCompletion(trx, {
        companyId,
        jobOperationId,
        count: 2
      })
    );

    expect(result.trackedEntityIds).toEqual([id("unit-3"), id("unit-2")]);
    expect(await quantities()).toEqual({
      rows: { plain: 1, s1: 1 },
      complete: 2
    });

    await db
      .transaction()
      .execute((trx) =>
        restoreSensorProduction(trx, { companyId, changes: result.changes })
      );
    expect((await quantities()).complete).toBe(4);
  });
});
