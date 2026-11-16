// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

// The count step of a Pulse device against a live local database: which
// buckets it reads, what it plans, and the cursor it moves.
//   SUPABASE_DB_URL=… pnpm --filter @carbon/jobs exec vitest run oee-sync-device-counts
//
// Each test runs inside one transaction that is always rolled back. Fixtures
// are inserted with `session_replication_role = replica` (FKs and triggers
// off). The poster and the label print are stubs: they post through the ERP's
// registered postings, which a jobs test process does not have.

import { randomUUID } from "node:crypto";
import type { KyselyDatabase } from "@carbon/database/client";
import type { DatabaseConnection } from "kysely";
import { CompiledQuery, Kysely, PostgresDialect, PostgresDriver } from "kysely";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { countOeeDevice, type PostCounts } from "./oee-sync-device-counts";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const hasLocalDatabase = (() => {
  try {
    return LOCAL_HOSTS.includes(
      new URL(process.env.SUPABASE_DB_URL ?? "").hostname
    );
  } catch {
    return false;
  }
})();

/** `countOeeDevice` opens its own transaction: run it as a savepoint. */
class SavepointDriver extends PostgresDriver {
  override async beginTransaction(connection: DatabaseConnection) {
    await connection.executeQuery(CompiledQuery.raw("SAVEPOINT count"));
  }
  override async commitTransaction(connection: DatabaseConnection) {
    await connection.executeQuery(CompiledQuery.raw("RELEASE SAVEPOINT count"));
  }
  override async rollbackTransaction(connection: DatabaseConnection) {
    await connection.executeQuery(
      CompiledQuery.raw("ROLLBACK TO SAVEPOINT count")
    );
  }
}

type Row = Record<string, unknown>;

describe.skipIf(!hasLocalDatabase)(
  "countOeeDevice against a migrated database",
  () => {
    const client = new Client({
      connectionString: process.env.SUPABASE_DB_URL
    });
    const config = {
      pool: {
        connect: async () =>
          Object.assign(client, { release: () => undefined }),
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
    const workCenterId = id("wc");
    const operationId = id("op");
    const pulseDeviceId = id("pdv");
    const deviceKey = `t${run}`;

    // Old fixed instants, all well before the step's cutoff (now − 10 s).
    const at = (hhmmss: string) => `2020-01-01T${hhmmss}.000Z`;

    async function insert(table: string, given: Row) {
      const row: Row = { companyId, createdBy: "system", ...given };
      for (const key of Object.keys(row)) {
        if (row[key] === undefined) delete row[key];
      }
      const columns = Object.keys(row);
      await client.query(
        `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
        Object.values(row)
      );
    }

    async function seed(device: Row = {}) {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await insert("workCenter", { id: workCenterId, name: "Press" });
      await insert("jobOperation", {
        id: operationId,
        jobId: id("job"),
        processId: id("process"),
        status: "In Progress"
      });
      await client.query(
        `INSERT INTO "workCenterLoad" ("companyId", "workCenterId", "jobOperationId", "loadedAt")
         VALUES ($1, $2, $3, $4)`,
        [companyId, workCenterId, operationId, at("08:00:00")]
      );
      await insert("pulseDevice", {
        id: pulseDeviceId,
        deviceKey,
        name: "Press sensor",
        piecesPerPulse: 2
      });
      await insert("workCenterDevice", {
        id: id("wcd"),
        workCenterId,
        integration: "pulse",
        externalDeviceId: deviceKey,
        deviceName: "Press sensor",
        countMode: "Auto",
        scrapReasonId: id("reason"),
        ...device
      });
    }

    let seq = 0;
    async function bucket(
      start: string,
      end: string,
      pulses: number,
      scrapPulses: number,
      receivedAt: string
    ) {
      seq += 1;
      await insert("pulseCount", {
        createdBy: undefined,
        pulseDeviceId,
        bootId: "b1",
        seq,
        periodStart: at(start),
        periodEnd: at(end),
        pulses,
        scrapPulses,
        counter: seq,
        receivedAt: at(receivedAt)
      });
    }

    const calls: Parameters<PostCounts>[1][] = [];
    const printed: string[] = [];
    const postCounts: PostCounts = async (_db, args) => {
      calls.push(args);
      return {
        labels: [
          {
            trackedEntityId: "unit-1",
            jobOperationId: operationId,
            jobMakeMethodId: null,
            workCenterId
          }
        ]
      };
    };

    async function count() {
      return countOeeDevice({
        db,
        device: { workCenterId, companyId },
        postCounts,
        printLabel: async (label) => {
          printed.push(label.trackedEntityId);
        }
      });
    }

    async function rows() {
      const postings = await client.query(
        `SELECT "jobOperationId", type, quantity::float AS quantity, reclassify, status
           FROM "machineCountPosting" WHERE "companyId" = $1 ORDER BY type::text`,
        [companyId]
      );
      const unattributed = await client.query(
        `SELECT reason, quantity::float AS quantity, "scrapQuantity"::float AS "scrapQuantity"
           FROM "unattributedMachineCount" WHERE "companyId" = $1`,
        [companyId]
      );
      const device = await client.query(
        `SELECT "countedThrough" IS NOT NULL AS moved, "countedThrough" > $2::timestamptz AS "pastFixtures"
           FROM "workCenterDevice" WHERE "companyId" = $1`,
        [companyId, at("23:59:59")]
      );
      return {
        postings: postings.rows,
        unattributed: unattributed.rows,
        device: device.rows[0]
      };
    }

    beforeAll(async () => {
      await client.connect();
    });
    afterEach(async () => {
      await client.query("ROLLBACK");
      calls.length = 0;
      printed.length = 0;
    });
    afterAll(async () => {
      await client.end();
    });

    it("plans the buckets of a device in Auto, posts them and prints the labels", async () => {
      await seed();
      // 5 strokes, 1 of them bad, at 2 pieces per stroke.
      await bucket("09:00:00", "09:00:05", 3, 0, "09:00:06");
      await bucket("09:00:05", "09:00:10", 2, 1, "09:00:11");

      expect(await count()).toMatchObject({ labels: 1 });

      expect(await rows()).toEqual({
        postings: [
          {
            jobOperationId: operationId,
            type: "Production",
            quantity: 8,
            reclassify: false,
            status: "Pending"
          },
          {
            jobOperationId: operationId,
            type: "Scrap",
            quantity: 2,
            reclassify: false,
            status: "Pending"
          }
        ],
        unattributed: [],
        device: { moved: true, pastFixtures: true }
      });
      expect(calls).toEqual([
        {
          companyId,
          workCenterId,
          scrapReasonId: id("reason"),
          labelEveryQuantity: null
        }
      ]);
      expect(printed).toEqual(["unit-1"]);
    });

    it("never reads a bucket received at or before the cursor", async () => {
      await seed({ countedThrough: at("09:00:10") });
      await bucket("09:00:00", "09:00:05", 3, 0, "09:00:06");
      await bucket("09:00:05", "09:00:10", 1, 0, "09:00:11");

      await count();

      expect((await rows()).postings).toEqual([
        {
          jobOperationId: operationId,
          type: "Production",
          quantity: 2,
          reclassify: false,
          status: "Pending"
        }
      ]);
    });

    it("queues a bucket counted before the operation was loaded", async () => {
      await seed();
      await bucket("07:00:00", "07:00:05", 4, 0, "07:00:06");

      await count();

      expect(await rows()).toMatchObject({
        postings: [],
        unattributed: [{ reason: "NoLoad", quantity: 8, scrapQuantity: 0 }]
      });
    });

    it("leaves a bucket received in the settle window and asks for a recheck", async () => {
      await seed();
      await bucket("09:00:00", "09:00:05", 3, 0, "09:00:06");
      // Received just now: inside the settle window.
      await client.query(
        `UPDATE "pulseCount" SET "receivedAt" = now() WHERE "companyId" = $1 AND seq = $2`,
        [companyId, seq]
      );

      const result = await count();

      expect(result?.plan.postings).toEqual([]);
      expect(result?.recheckAt).not.toBeNull();
      expect((await rows()).postings).toEqual([]);
    });

    it("does nothing for a device in count mode Off", async () => {
      await seed({ countMode: "Off" });
      await bucket("09:00:00", "09:00:05", 3, 0, "09:00:06");

      expect(await count()).toBeNull();
      expect(await rows()).toEqual({
        postings: [],
        unattributed: [],
        device: { moved: false, pastFixtures: null }
      });
      expect(calls).toEqual([]);
    });
  }
);
