# Pulse Phase 3: automatic quantities and tracking labels — implementation plan

**Spec:** .ai/specs/2026-11-14-pulse-machine-monitoring.md (Phase 3, and "API / Service Changes" → the label decisions of 2026-11-16)
**Parent plan:** .ai/plans/2026-11-14-pulse-machine-monitoring.md (Phase 3 checklist)
**Closest sibling:** Unattributed machine time (`unattributedMachineTime`, `x+/production+/machine-time*.tsx`, `assignUnattributedMachineTime`). Unattributed Counts copies it file for file.
**Branch:** `feat/pulse-machine-monitoring`

## What this phase does

The sensor posts Log completed and Log scrap on the operation loaded on the
work center, the same way the MES does. Tracked units print their label.

1. Ingest stores `pulseCount` rows (done in Phase 1). Each row has `pulses`
   and `scrapPulses`.
2. The OEE sync of a Pulse device in count mode `Auto` runs a count step after
   `syncOeeDevice`. The count step reads the rows received since
   `workCenterDevice.countedThrough`.
3. A pure planner, `planMachineCounts`, assigns each row to the load that
   covers the middle of its period. It returns `machineCountPosting` rows to
   create and `unattributedMachineCount` rows for counts no operation can
   take.
4. A poster, `postMachineCounts`, posts each pending row through the `issue`
   posting (`jobOperationBatchComplete`, `jobOperationSerialComplete`,
   `jobOperationScrap`), or inserts a `productionQuantity` row and runs the
   `jobOperation` issue for an untracked operation. It returns the labels to
   print.
5. `printOperationLabel` (moved from the MES to `@carbon/printing`) prints
   each label with the existing printer config.

## Decisions made while planning

These refine the spec. Task 16 writes them into the spec.

| Topic | Decision | Why |
|---|---|---|
| Which rows the sensor made | `machineCountPosting.productionQuantityId` links a sensor posting to its `productionQuantity` row. `productionQuantity` gets no new column | No schema change on a production table that every completion writes |
| Cursor | `workCenterDevice.countedThrough` is a `receivedAt` cursor. The count step reads rows received after it and up to 10 seconds before now | Ingest writes one device's rows in order. A late bucket (network replay) has an old period but a new `receivedAt`, so it is still read |
| Switching to Auto | The ee write sets `countedThrough = now()` when the mode becomes `Auto` | Counts from before the switch never post |
| Scrap reason | `workCenterDevice.scrapReasonId`, set on the mapping. Without it, Log scrap presses go to Unattributed Counts | `jobOperationScrap` requires a scrap reason |
| Scrap after the stroke posted | A Log scrap press first lowers the newest sensor Production of the operation, then posts the Scrap. For a serial unit it deletes the unit's sensor Production row, then scraps that unit | The backflush issues for complete + scrapped units. Scrap first, then lower, issues material twice for one piece |
| Over the target | The poster posts up to `targetQuantity − (quantityComplete + quantityReworked)`. The rest goes to Unattributed Counts with reason `OverTarget` | The operation closes at its target, as the spec says |
| Idempotency | The poster writes `notes = "Pulse sensor <machineCountPosting.id>"` on the `productionQuantity` row. Before it posts a pending row, it looks for that note | The `issue` posting runs in its own transaction, so a crash between the posting and the mark must not post twice |
| Retention | Only `util.purge_work_center_loads()` changes in this phase. `util.purge_machine_state_changes()` waits for Phase 4 | Phase 3 needs old loads for late buckets; the 400-day OEE history is a Phase 4 need |

## Progress
- [x] Task 1: Migration — counting columns and the two count tables
- [x] Task 2: Regenerate types and add the authz rules
- [x] Task 3: Move the operation label print to `@carbon/printing`
- [x] Task 4: `planMachineCounts`, the pure planner, with tests
- [x] Task 5: `@carbon/database/machine-counts` — lower and restore sensor Production
- [x] Task 6: `postMachineCounts`, the poster
- [x] Task 7: The count step in the OEE sync
- [x] Task 8: Ingest wakes the sync for counts
- [x] Task 9: The counting settings on the ERP device mapping
- [x] Task 10: Unattributed Counts — service functions
- [x] Task 11: Unattributed Counts — ERP pages
- [x] Task 12: MES — refuse a manual Log completed in Auto mode
- [x] Task 13: MES — "Counted by the sensor" on Log scrap
- [x] Task 14: Translations
- [x] Task 15: Scoped gates
- [x] Task 16: Docs
- [ ] Task 17: End-to-end check with the simulator and the browser

## Dependencies
- Task 2 needs Task 1. Every later task needs Task 2 (types).
- Tasks 3, 4 and 5 are independent of each other.
- Task 6 needs Tasks 3, 4 and 5. Task 7 needs Task 6.
- Task 8 is independent of Tasks 3–7.
- Task 9 needs Task 2. Tasks 10–11 need Task 6.
- Tasks 12–13 need Task 5.
- Task 14 needs Tasks 9, 11, 12 and 13. Task 15 needs Tasks 3–14.
- Task 16 needs Task 15. Task 17 needs Task 16.

---

## Task 1: Migration — counting columns and the two count tables

**Depends on:** none
**Files:**
- Create: `packages/database/supabase/migrations/<timestamp>_pulse-machine-counts.sql` (made by the command below)
- Copy from (precedent): `packages/database/supabase/migrations/20261013030022_oee-provider.sql` (the `unattributedMachineTime` table) and `20261014024119_oee-load-is-history.sql` (lines 123-139, `util.purge_work_center_loads`)

**Steps:**
1. Run `pnpm db:migrate:new pulse-machine-counts`.
2. Read `20261014024119_oee-load-is-history.sql` lines 123-139. Copy the body of `util.purge_work_center_loads()` exactly.
3. Read the `scrapReason` table in `packages/database/src/types.ts`. Note its primary key.
4. Write this SQL into the new file. Add the copied purge body where the comment says.

```sql
-- Pulse Phase 3: the sensor posts Log completed and Log scrap.

DO $$ BEGIN
  CREATE TYPE "machineCountMode" AS ENUM ('Off', 'Auto');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "machineCountPostingStatus" AS ENUM ('Pending', 'Posted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "unattributedMachineCountReason" AS ENUM (
    'NoLoad', 'Blocked', 'OperationClosed', 'OverTarget',
    'SerialNeedsSendEachPulse', 'NoScrapReason', 'Refused'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "workCenterDevice"
  ADD COLUMN IF NOT EXISTS "countMode" "machineCountMode" NOT NULL DEFAULT 'Off',
  ADD COLUMN IF NOT EXISTS "countedThrough" TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS "scrapReasonId" TEXT,
  ADD COLUMN IF NOT EXISTS "labelEveryQuantity" NUMERIC;

ALTER TABLE "workCenterDevice" DROP CONSTRAINT IF EXISTS "workCenterDevice_labelEveryQuantity_check";
ALTER TABLE "workCenterDevice" ADD CONSTRAINT "workCenterDevice_labelEveryQuantity_check"
  CHECK ("labelEveryQuantity" IS NULL OR "labelEveryQuantity" > 0);

-- The scrap reason FK: match the scrapReason primary key read in step 3.
-- If it is ("id", "companyId"):
ALTER TABLE "workCenterDevice" DROP CONSTRAINT IF EXISTS "workCenterDevice_scrapReasonId_fkey";
ALTER TABLE "workCenterDevice" ADD CONSTRAINT "workCenterDevice_scrapReasonId_fkey"
  FOREIGN KEY ("scrapReasonId", "companyId") REFERENCES "scrapReason"("id", "companyId")
  ON DELETE SET NULL ("scrapReasonId");
CREATE INDEX IF NOT EXISTS "workCenterDevice_scrapReasonId_idx" ON "workCenterDevice" ("scrapReasonId");

-- One row per productionQuantity row the sensor makes.
CREATE TABLE IF NOT EXISTS "machineCountPosting" (
  "id" TEXT NOT NULL DEFAULT id('mcp'),
  "companyId" TEXT NOT NULL,
  "workCenterId" TEXT NOT NULL,
  "jobOperationId" TEXT NOT NULL,
  "type" "productionQuantityType" NOT NULL,
  -- Pieces: pulses × piecesPerPulse. A serial row is 1.
  "quantity" NUMERIC NOT NULL,
  -- True for a Log scrap that lowers Production already posted.
  "reclassify" BOOLEAN NOT NULL DEFAULT FALSE,
  "periodStart" TIMESTAMP WITH TIME ZONE NOT NULL,
  "periodEnd" TIMESTAMP WITH TIME ZONE NOT NULL,
  "status" "machineCountPostingStatus" NOT NULL DEFAULT 'Pending',
  "trackedEntityId" TEXT,
  "productionQuantityId" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdBy" TEXT NOT NULL REFERENCES "user"("id"),
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedBy" TEXT REFERENCES "user"("id"),
  "updatedAt" TIMESTAMP WITH TIME ZONE,
  CONSTRAINT "machineCountPosting_pkey" PRIMARY KEY ("id", "companyId"),
  CONSTRAINT "machineCountPosting_companyId_fkey" FOREIGN KEY ("companyId")
    REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "machineCountPosting_workCenterId_fkey" FOREIGN KEY ("workCenterId", "companyId")
    REFERENCES "workCenter"("id", "companyId") ON DELETE CASCADE,
  CONSTRAINT "machineCountPosting_jobOperationId_fkey" FOREIGN KEY ("jobOperationId", "companyId")
    REFERENCES "jobOperation"("id", "companyId") ON DELETE CASCADE,
  CONSTRAINT "machineCountPosting_trackedEntityId_fkey" FOREIGN KEY ("trackedEntityId", "companyId")
    REFERENCES "trackedEntity"("id", "companyId") ON DELETE SET NULL ("trackedEntityId"),
  CONSTRAINT "machineCountPosting_productionQuantityId_fkey" FOREIGN KEY ("productionQuantityId", "companyId")
    REFERENCES "productionQuantity"("id", "companyId") ON DELETE SET NULL ("productionQuantityId"),
  CONSTRAINT "machineCountPosting_quantity_check" CHECK ("quantity" > 0),
  CONSTRAINT "machineCountPosting_period_check" CHECK ("periodEnd" >= "periodStart")
);
CREATE INDEX IF NOT EXISTS "machineCountPosting_companyId_idx" ON "machineCountPosting" ("companyId");
CREATE INDEX IF NOT EXISTS "machineCountPosting_workCenterId_idx" ON "machineCountPosting" ("workCenterId");
CREATE INDEX IF NOT EXISTS "machineCountPosting_jobOperationId_idx" ON "machineCountPosting" ("jobOperationId", "createdAt");
CREATE INDEX IF NOT EXISTS "machineCountPosting_trackedEntityId_idx" ON "machineCountPosting" ("trackedEntityId");
CREATE INDEX IF NOT EXISTS "machineCountPosting_productionQuantityId_idx" ON "machineCountPosting" ("productionQuantityId");
CREATE INDEX IF NOT EXISTS "machineCountPosting_pending_idx" ON "machineCountPosting" ("workCenterId") WHERE "status" = 'Pending';
CREATE INDEX IF NOT EXISTS "machineCountPosting_createdBy_idx" ON "machineCountPosting" ("createdBy");
CREATE INDEX IF NOT EXISTS "machineCountPosting_updatedBy_idx" ON "machineCountPosting" ("updatedBy");

-- Counts no operation could take. A supervisor assigns or dismisses them.
CREATE TABLE IF NOT EXISTS "unattributedMachineCount" (
  "id" TEXT NOT NULL DEFAULT id('umc'),
  "companyId" TEXT NOT NULL,
  "workCenterId" TEXT NOT NULL,
  "periodStart" TIMESTAMP WITH TIME ZONE NOT NULL,
  "periodEnd" TIMESTAMP WITH TIME ZONE NOT NULL,
  -- Pieces, already multiplied by piecesPerPulse.
  "quantity" NUMERIC NOT NULL DEFAULT 0,
  "scrapQuantity" NUMERIC NOT NULL DEFAULT 0,
  "reason" "unattributedMachineCountReason" NOT NULL,
  "detail" TEXT,
  "jobOperationId" TEXT,
  "createdBy" TEXT NOT NULL REFERENCES "user"("id"),
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedBy" TEXT REFERENCES "user"("id"),
  "updatedAt" TIMESTAMP WITH TIME ZONE,
  CONSTRAINT "unattributedMachineCount_pkey" PRIMARY KEY ("id", "companyId"),
  CONSTRAINT "unattributedMachineCount_companyId_fkey" FOREIGN KEY ("companyId")
    REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "unattributedMachineCount_workCenterId_fkey" FOREIGN KEY ("workCenterId", "companyId")
    REFERENCES "workCenter"("id", "companyId") ON DELETE CASCADE,
  CONSTRAINT "unattributedMachineCount_jobOperationId_fkey" FOREIGN KEY ("jobOperationId", "companyId")
    REFERENCES "jobOperation"("id", "companyId") ON DELETE SET NULL ("jobOperationId"),
  CONSTRAINT "unattributedMachineCount_quantity_check"
    CHECK ("quantity" >= 0 AND "scrapQuantity" >= 0 AND "quantity" + "scrapQuantity" > 0),
  CONSTRAINT "unattributedMachineCount_period_check" CHECK ("periodEnd" >= "periodStart")
);
CREATE INDEX IF NOT EXISTS "unattributedMachineCount_companyId_idx" ON "unattributedMachineCount" ("companyId");
CREATE INDEX IF NOT EXISTS "unattributedMachineCount_workCenterId_idx" ON "unattributedMachineCount" ("workCenterId", "periodStart");
CREATE INDEX IF NOT EXISTS "unattributedMachineCount_jobOperationId_idx" ON "unattributedMachineCount" ("jobOperationId");
CREATE INDEX IF NOT EXISTS "unattributedMachineCount_createdBy_idx" ON "unattributedMachineCount" ("createdBy");
CREATE INDEX IF NOT EXISTS "unattributedMachineCount_updatedBy_idx" ON "unattributedMachineCount" ("updatedBy");

-- Keep a load while the count step may still read a late bucket for it.
CREATE OR REPLACE FUNCTION util.purge_work_center_loads()
-- <copy the signature and body from 20261014024119 lines 123-139, then add
--  to its NOT EXISTS subquery:
--    OR (d."countMode" = 'Auto' AND (d."countedThrough" IS NULL OR d."countedThrough" < l."unloadedAt"))
--  inside the same parentheses as the appliedThrough test>
;

-- Posted rows are history: keep 90 days.
CREATE OR REPLACE FUNCTION util.purge_machine_counts()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM "machineCountPosting"
   WHERE "status" = 'Posted' AND "createdAt" < NOW() - INTERVAL '90 days';
  DELETE FROM "unattributedMachineCount"
   WHERE "periodEnd" < NOW() - INTERVAL '90 days';
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'machine-count-retention') THEN
    PERFORM cron.unschedule('machine-count-retention');
  END IF;
  PERFORM cron.schedule('machine-count-retention', '47 4 * * *', 'SELECT util.purge_machine_counts()');
END $$;
```

5. If the `scrapReason` primary key is `("id")` only, use `REFERENCES "scrapReason"("id") ON DELETE SET NULL` instead. Use the same single-column form for any other table whose key is not `("id", "companyId")`.
6. Copy the `cron.schedule` form from `20261114131742_pulse-machine-monitor.sql` lines 165-180 if it differs from step 4.
7. Run `bash packages/dev/bin/crbn migrate`. (On Windows, `pnpm db:migrate` fails in cmd.exe.)

**Verify:**
```bash
docker exec carbon-postgres psql -U postgres -d wt_carbon -Atc "select count(*) from \"machineCountPosting\"; select count(*) from \"unattributedMachineCount\"; select \"countMode\" from \"workCenterDevice\" limit 1"
# Expected: 0, 0, Off (no error)
```

**Out of scope:** any change to `productionQuantity`; `util.purge_machine_state_changes()` (Phase 4).

## Task 2: Regenerate types and add the authz rules

**Depends on:** Task 1
**Files:**
- Modify: `packages/database/src/types.ts` (generated)
- Modify: `packages/database/src/authz/manifest.ts` — rules for `machineCountPosting` and `unattributedMachineCount`
- Create: `packages/database/supabase/migrations/<timestamp>_<name>.sql` (generated by `authz migration`)
- Copy from (precedent): the `unattributedMachineTime` entry in `manifest.ts`

**Steps:**
1. Run `pnpm run generate:types`.
2. Find the `unattributedMachineTime` rule in `manifest.ts`.
3. Add `unattributedMachineCount` with the same rule.
4. Add `machineCountPosting` with the same rule.
5. Run `bash packages/dev/bin/crbn migrate` to sync the rules locally.
6. Run `pnpm --filter @carbon/database authz migration pulse-machine-counts-rls`.

**Verify:**
```bash
pnpm --filter @carbon/database authz check
# Expected: exit 0 (no drift)
pnpm --filter @carbon/database exec vitest run src/authz
# Expected: all pass
```

**Out of scope:** any other table's rule.

## Task 3: Move the operation label print to `@carbon/printing`

**Depends on:** Task 2
**Files:**
- Create: `packages/printing/src/operation-label.server.ts`
- Modify: `packages/printing/package.json` — export `./operation-label.server`; add `@carbon/database`, `@carbon/lib`, `@carbon/logger` as `workspace:*` dependencies
- Modify: `apps/mes/app/services/printing.server.ts` — `autoPrintOperationLabel` calls the package function
- Modify: `apps/mes/app/services/operations.service.ts` — `isFirstOperationOfMakeMethod` and `isLastOperationOfMakeMethod` re-export the package functions
- Copy from (precedent): `apps/mes/app/services/printing.server.ts:50-193`, `apps/mes/app/services/operations.service.ts:330-371`

**Steps:**
1. Move `autoPrintOperationLabel`, `hasJobTravelerPrinted`, `isFirstOperationOfMakeMethod` and `isLastOperationOfMakeMethod` into the new file.
2. Rename the moved `autoPrintOperationLabel` to `printOperationLabel`. Keep its body and its arguments.
3. Type the client argument as `SupabaseClient<Database>` (`@supabase/supabase-js`, `@carbon/database`).
4. Import `trigger` from `@carbon/lib/trigger`, not from `@carbon/jobs`.
5. In the MES, make `autoPrintOperationLabel` call `printOperationLabel` with the same arguments.
6. In `operations.service.ts`, replace the two function bodies with re-exports from `@carbon/printing/operation-label.server`.
7. Run `pnpm install` to link the new dependencies.
8. Run `pnpm --filter @carbon/checks license-headers` to write the AGPL header.

If `@carbon/lib` depends on `@carbon/printing` (a cycle), STOP and report — do not improvise.

**Verify:**
```bash
pnpm --filter @carbon/printing typecheck && pnpm exec turbo run typecheck --filter=mes
# Expected: no errors
```

**Out of scope:** the print-job resolver; label templates; the ERP.

## Task 4: `planMachineCounts`, the pure planner, with tests

**Depends on:** Task 2
**Files:**
- Create: `packages/ee/src/oee/counts.ts`, `packages/ee/src/oee/counts.test.ts`
- Modify: the file that `packages/ee/package.json` maps `./oee` to — export `planMachineCounts` and its types
- Copy from (precedent): `packages/ee/src/oee/engine.ts` (`LoadPeriod`, `BlockPeriod`, `contains`) and `engine.test.ts` (the `base()` builder)

**Steps:**
1. Export `contains(period, instant)` from `engine.ts`. Do not change its behavior.
2. Write `planMachineCounts(input): MachineCountPlan` with these types:

```ts
export type CountBucket = { periodStart: string; periodEnd: string; pulses: number; scrapPulses: number };
export type CountOperation = { jobOperationId: string; tracking: "None" | "Serial" | "Batch" };
export type PlanMachineCountsInput = {
  buckets: CountBucket[];            // ordered by periodStart
  loads: LoadPeriod[];               // from engine.ts
  blocks: BlockPeriod[];
  operations: CountOperation[];      // tracking of each loaded operation
  piecesPerPulse: number;
  sendEachPulse: boolean;
  hasScrapReason: boolean;
};
export type PlannedPosting = {
  jobOperationId: string;
  type: "Production" | "Scrap";
  quantity: number;                  // pieces
  reclassify: boolean;
  periodStart: string; periodEnd: string;
};
export type PlannedUnattributed = {
  periodStart: string; periodEnd: string;
  quantity: number; scrapQuantity: number;   // pieces
  reason: "NoLoad" | "Blocked" | "OperationClosed" | "SerialNeedsSendEachPulse" | "NoScrapReason";
};
export type MachineCountPlan = { postings: PlannedPosting[]; unattributed: PlannedUnattributed[] };
```

3. Implement these rules, in this order, for each bucket:
   1. The bucket's instant is the middle of its period.
   2. If a block contains the instant, the bucket is unattributed, reason `Blocked`.
   3. If no load contains the instant, reason `NoLoad`.
   4. If the load is not `assignable`, reason `OperationClosed`.
   5. If the operation is `Serial` and `sendEachPulse` is false, reason `SerialNeedsSendEachPulse`.
4. Group the attributed buckets by operation, keeping their order.
5. For each operation, sum `pulses` (P) and `scrapPulses` (S).
6. Production pieces = `max(0, P − S) × piecesPerPulse`.
7. In-batch scrap pieces = `min(P, S) × piecesPerPulse`.
8. Reclassify scrap pieces = `max(0, S − P) × piecesPerPulse`.
9. If `hasScrapReason` is false, both scrap amounts become one unattributed row, reason `NoScrapReason`.
10. For `Serial`, return one `Production` posting of quantity 1 per piece, and one `Scrap` posting of quantity 1 per scrap piece.
11. For `None` and `Batch`, return at most one `Production` and at most 2 `Scrap` postings per operation: in-batch (`reclassify: false`) and reclassify (`reclassify: true`).
12. A posting's period is the first and last bucket of its group.
13. Merge unattributed buckets with the same reason that follow each other into one row.
14. Never return a posting or a row with quantity 0.
15. Write tests with a `base()` builder. Cover: one bucket on a load; a bucket between two loads; a blocked bucket; no load; a closed operation; serial with and without `sendEachPulse`; scrap in the same batch (net); scrap beyond the batch (reclassify); no scrap reason; `piecesPerPulse` 2; merging of unattributed rows.
16. Run `pnpm --filter @carbon/checks license-headers` (commercial header).

**Verify:**
```bash
pnpm --filter @carbon/ee exec vitest run src/oee/counts.test.ts src/oee/engine.test.ts
# Expected: all pass
```

**Out of scope:** the target split (Task 6 does it with live quantities); any I/O.

## Task 5: `@carbon/database/machine-counts` — lower and restore sensor Production

**Depends on:** Task 2
**Files:**
- Create: `packages/database/src/machine-counts.ts`, `packages/database/src/machine-counts.test.ts`
- Modify: `packages/database/package.json` — export `./machine-counts`
- Copy from (precedent): `packages/database/src/machine-time.ts` (Kysely building blocks that take a transaction) and `machine-time.test.ts` (local database test)

**Steps:**
1. Write `lowerSensorProduction(trx, { companyId, jobOperationId, quantity, userId })`.
   1. Lock the `jobOperation` row `FOR UPDATE`.
   2. Read the operation's `Posted` `machineCountPosting` rows of type `Production` with a `productionQuantityId`, newest first.
   3. Lower their `productionQuantity.quantity` until `quantity` pieces are removed. Delete a row that reaches 0.
   4. If the operation's item is batch tracked, set the lot's `trackedEntity.quantity` to the sum of the operation's `Production` rows. Copy the rule of `produceBatchOutput` (`apps/erp/app/modules/inventory/inventory.service.ts:29928-29998`).
   5. Return `{ lowered: number, changes: { productionQuantityId, before, after }[] }`.
2. Write `restoreSensorProduction(trx, { companyId, changes })`. It puts each row back to `before` (re-insert a deleted row with its old id and columns).
3. Write `removeSerialSensorCompletion(trx, { companyId, jobOperationId, count })`. It deletes the `productionQuantity` rows of the newest `count` `Posted` serial `Production` postings that still have a `productionQuantityId`. It returns their `trackedEntityId`s.
4. Scope every statement by `companyId`.
5. Write tests with the local database fixtures: lower across 2 rows; delete a row that reaches 0; restore; serial removal returns the newest units.

If `productionQuantity` refuses an UPDATE of `quantity` (a trigger or CHECK), STOP and report — do not improvise.

**Verify:**
```bash
pnpm --filter @carbon/database exec vitest run src/machine-counts.test.ts
# Expected: all pass (skipped without a local database)
pnpm --filter @carbon/database typecheck
# Expected: no errors
```

**Out of scope:** posting the Scrap (Task 6 and Task 13 do it).

## Task 6: `postMachineCounts`, the poster

**Depends on:** Tasks 3, 4, 5
**Files:**
- Create: `packages/ee/src/oee/counts.server.ts`, `packages/ee/src/oee/counts-target.test.ts`
- Modify: the file that `packages/ee/package.json` maps `./oee.server` to — export `postMachineCounts` and `MachineCountLabel`
- Copy from (precedent): `postEndedMachineEvents` in `packages/ee/src/oee/service.server.ts:119-139` (calls `posting(...)`, logs, never throws)

**Steps:**
1. Write a pure helper `splitAtTarget({ quantity, targetQuantity, quantityComplete, quantityReworked })` → `{ post, over }`. With no target (null or 0), `over` is 0.
2. Test `splitAtTarget` in `counts-target.test.ts`.
3. Write `postMachineCounts(db, { companyId, workCenterId, scrapReasonId, labelEveryQuantity })`. It returns `{ labels: MachineCountLabel[] }`, where `MachineCountLabel = { trackedEntityId, jobOperationId, jobMakeMethodId, workCenterId }`.
4. It reads the `Pending` rows of the work center, oldest first. For each row:
   1. Read the operation, its job, its make method's item tracking and its quantities.
   2. If `machineTimeRefusal(operationStatus, jobStatus)` is not null, move the row to `unattributedMachineCount` (reason `OperationClosed`). Delete the posting row.
   3. If a `productionQuantity` row has `notes = "Pulse sensor <row.id>"`, mark the row `Posted` with that id. Continue.
   4. For `Production`, apply `splitAtTarget`. Move `over` pieces to `unattributedMachineCount` (reason `OverTarget`).
5. Post a `Production` row by tracking:
   - **None:** call `posting("issue", handles, { type: "jobOperationDryRun", id, quantity })`. On a refusal, move the row to Unattributed (reason `Refused`, `detail` = the message). Else, in one Kysely transaction, insert the `productionQuantity` row (`type 'Production'`, `createdBy 'system'`, the note) and mark the posting `Posted`. Then call `posting("issue", handles, { type: "jobOperation", id, quantity })`.
   - **Batch:** read the lot (the first `trackedEntity` of the make method, same order as `getTrackedEntitiesByMakeMethodId`). Call `jobOperationBatchComplete` with the note. Read the new `productionQuantity` id by the note. Add a label when the lot passes a multiple of `labelEveryQuantity`, or on the first sensor completion when it is null.
   - **Serial:** pick the next incomplete unit with the rule of `isSerialEntityIncompleteForOperation` (`apps/mes/app/services/operations.service.ts:2466-2479`). Call `jobOperationSerialComplete` with the note. Store `trackedEntityId`. Add a label for the unit.
6. Post a `Scrap` row:
   - If `scrapReasonId` is null, move the row to Unattributed (reason `NoScrapReason`).
   - If `reclassify`, run `lowerSensorProduction` (None, Batch) or `removeSerialSensorCompletion` (Serial) in a transaction first.
   - Call `jobOperationScrap` with `scrapReasonId` and the note. For Serial, pass the unit: the removed unit, else the next incomplete unit.
   - If the scrap posting fails after a lower, run `restoreSensorProduction`.
7. On a refusal (an error with a status below 500), move the row to Unattributed (reason `Refused`, `detail` = the message).
8. On any other error, add 1 to `attempts` and write `lastError`. After 5 attempts, move the row to Unattributed (reason `Refused`).
9. Use `handles = { db, companyId, userId: "system" }` for every posting.
10. Log each failure with `@carbon/logger`. Never throw.

If `posting("issue", …)` cannot be called from `packages/ee` (not in `PostingContract`), STOP and report — do not improvise.

**Verify:**
```bash
pnpm --filter @carbon/ee exec vitest run src/oee/counts-target.test.ts && pnpm --filter @carbon/ee typecheck
# Expected: all pass, no errors
```

**Out of scope:** printing (the caller prints the returned labels); the MES routes.

## Task 7: The count step in the OEE sync

**Depends on:** Task 6
**Files:**
- Create: `packages/jobs/src/inngest/functions/integrations/oee-sync-device-counts.ts`, `oee-sync-device-counts.database.test.ts`
- Modify: `packages/jobs/src/inngest/functions/integrations/oee-sync-device.ts` — export the load and block reads as `readLoads(trx, device, from)` and `readBlocks(trx, device, from)`
- Modify: `packages/jobs/src/inngest/functions/integrations/oee-sync.ts` — call the count step after `syncOeeDevice` (inside the same `try`, lines 92-110)
- Copy from (precedent): `oee-sync-device.ts` (lines 147-296) and `oee-sync-device.database.test.ts` (fixtures, `SavepointDriver`)

**Steps:**
1. Move the load query (lines 221-249, 340-347) and the block query (lines 255-296) into `readLoads` and `readBlocks`. `syncOeeDevice` calls them. Its behavior does not change.
2. Write `countOeeDevice({ db, device })`. Return at once unless `device.integration === "pulse"` and `countMode === "Auto"`.
3. In one transaction:
   1. `lockWorkCenterDevice(trx, …)`.
   2. Read `countedThrough`, `scrapReasonId` and `labelEveryQuantity` from the locked row.
   3. Read the `pulseDevice` by `deviceKey = externalDeviceId` (`piecesPerPulse`, `sendEachPulse`).
   4. Set `cutoff` = the database `now() − 10 seconds`.
   5. Read `pulseCount` rows of the device with `countedThrough < receivedAt <= cutoff`, ordered by `periodStart`.
   6. Read loads and blocks from the earliest `periodStart`.
   7. Read each loaded operation's tracking.
   8. Call `planMachineCounts`.
   9. Insert the planned postings and unattributed rows (`createdBy 'system'`).
   10. Set `countedThrough = cutoff`.
4. After the commit, call `postMachineCounts`.
5. For each returned label, call `printOperationLabel` (Task 3) with `getCarbonServiceRole()`.
6. Convert every Kysely timestamp to an ISO string before the planner sees it (Kysely returns `Date`; see `.ai/lessons.md` "Comparing a Kysely timestamp…").
7. In `syncDevices`, call `countOeeDevice` after `postEndedMachineEvents`. Do not add a key to the step's return value (`.ai/lessons.md` "A new key in an Inngest step's return…").
8. Write a database test: seed a Pulse device in Auto, a load, and 3 `pulseCount` rows. Run `countOeeDevice` with a stub poster. Assert the inserted postings, the unattributed rows and `countedThrough`.

**Verify:**
```bash
pnpm --filter @carbon/jobs exec vitest run src/inngest/functions/integrations/oee-sync-device
# Expected: the existing sync tests and the new count test pass (skipped without a local database)
pnpm --filter @carbon/jobs typecheck
# Expected: no errors
```

**Out of scope:** the sweep schedule; the Sense provider.

## Task 8: Ingest wakes the sync for counts

**Depends on:** Task 2
**Files:**
- Modify: `apps/pulse-ingest/src/store.ts` — `DeviceRow.countMode` from the `workCenterDevice` join
- Modify: `apps/pulse-ingest/src/device.ts` — call `onChanged` after a stored bucket when the device counts
- Modify: `apps/pulse-ingest/src/main.ts` — `wakeSync(device, reason)` with per-reason event ids

**Steps:**
1. Select `w.countMode` in `loadDevices`. Map it to `countMode: "Off" | "Auto" | null`.
2. In `DeviceWorker.count`, after a stored bucket, call `this.onCounted(this.row, payload)` when `mapped` and `countMode === "Auto"`.
3. In `main.ts`, use these event ids:
   - a state change: `pulse:<id>:<minute>` (as today);
   - a count, `sendEachPulse`: `pulse:<id>:count:<boot>:<seq>`;
   - a count, bucket mode: `pulse:<id>:count:<minute>`.
4. Add a test for the event id choice as a pure function `syncEventId(device, reason, now, bucket?)` in a new file `apps/pulse-ingest/src/wake.ts`.

**Verify:**
```bash
pnpm --filter pulse-ingest test && pnpm --filter pulse-ingest typecheck
# Expected: all pass, no errors
```

**Out of scope:** the MQTT contract (unchanged).

## Task 9: The counting settings on the ERP device mapping

**Depends on:** Task 2
**Files:**
- Modify: `packages/ee/src/types.ts` — descriptor flag `providesCounts?: boolean`
- Modify: `packages/ee/src/pulse/config.tsx` — `providesCounts: true`
- Modify: `packages/ee/src/oee/service.server.ts` — new `updateWorkCenterDeviceCounting(client, db, { companyId, userId, workCenterDeviceId, countMode, scrapReasonId, labelEveryQuantity })`
- Modify: `apps/erp/app/modules/settings/settings.models.ts` — `workCenterDeviceCountingValidator` (intent `update-work-center-device-counting`)
- Modify: `apps/erp/app/modules/settings/settings.server.ts` — service function `saveOeeDeviceCounting` (`permission: { update: "settings" }`)
- Modify: `apps/erp/app/modules/settings/settings.service.ts` — `getOeeDevicesTabData` selects `id, countMode, scrapReasonId, labelEveryQuantity` and returns the company's scrap reasons
- Modify: `apps/erp/app/routes/x+/settings+/integrations.$id.tsx` — the new intent
- Modify: `apps/erp/app/modules/settings/ui/Integrations/OeeDevices.ee.tsx` — a "Counting" button on a mapped row opens a modal form
- Copy from (precedent): `PulseDeviceForm` in `apps/erp/app/modules/settings/ui/Integrations/PulseDevices.ee.tsx` (modal + `ValidatedForm` + `useAction`); `saveOeeDeviceMapping` and `upsertWorkCenterDevice` for the service and ee write

**Steps:**
1. In the ee write, call `requireEntitlement(client, companyId, "INTEGRATIONS")` first.
2. Refuse `Auto` for a device whose integration descriptor has no `providesCounts`.
3. When the mode changes from `Off` to `Auto`, set `countedThrough = now()`.
4. Check that the scrap reason belongs to the company.
5. Show the "Counting" button only when the descriptor has `providesCounts`.
6. The form has 3 fields: "Count mode" (Select: Off, Auto), "Scrap reason for the Log scrap button" (Select of scrap reasons, optional), "Print a label every N pieces" (Number, optional, helper text "Batch items only. Empty: one label when the lot starts.").
7. Add a short text under the row in Auto: "Log completed from the sensor".

**Verify:**
```bash
pnpm --filter @carbon/ee typecheck
# Expected: no errors
```
Browser check in Task 17.

**Out of scope:** the Pulse Devices tab; the Sense descriptor.

## Task 10: Unattributed Counts — service functions

**Depends on:** Task 6
**Files:**
- Modify: `packages/ee/src/oee/service.server.ts` — `assignUnattributedMachineCount(client, db, { companyId, userId, unattributedMachineCountId, jobOperationId })` and `dismissUnattributedMachineCount(client, db, { companyId, unattributedMachineCountId })`
- Modify: `apps/erp/app/modules/production/production.service.ts` — `getUnattributedMachineCounts`, `getUnattributedMachineCount`
- Modify: `apps/erp/app/modules/production/production.server.ts` — the operations that wrap them
- Copy from (precedent): `assignUnattributedMachineTime` / `dismissUnattributedMachineTime` (`packages/ee/src/oee/service.server.ts:323`, `:409`); `getUnattributedMachineTimes` in `production.service.ts`

**Steps:**
1. In `assign`, call `requireEntitlement` first.
2. Lock the row. Lock the operation and its job. Refuse with `machineTimeRefusal`.
3. Insert `Pending` postings for the chosen operation: one `Production` row of `quantity`, and one `Scrap` row of `scrapQuantity` (`reclassify: false`).
4. Delete the unattributed row in the same transaction.
5. After the commit, call `postMachineCounts` for the work center.
6. Print the returned labels with `printOperationLabel`.
7. `dismiss` deletes the row. It refuses nothing else.

**Verify:**
```bash
pnpm --filter @carbon/ee typecheck
# Expected: no errors
```

**Out of scope:** the pages (Task 11).

## Task 11: Unattributed Counts — ERP pages

**Depends on:** Task 10
**Files:**
- Create: `apps/erp/app/routes/x+/production+/machine-counts.tsx`, `apps/erp/app/routes/x+/production+/machine-counts.$id.tsx`
- Create: `apps/erp/app/modules/production/ui/MachineCounts/MachineCountTable.ee.tsx`, `MachineCountDrawer.ee.tsx`
- Modify: `apps/erp/app/utils/path.ts` — `unattributedMachineCounts`, `unattributedMachineCount(id)`
- Modify: `apps/erp/app/modules/production/ui/useProductionSubmodules.tsx` — nav entry "Unattributed Counts" beside "Unattributed Time", same `hasOeeProvider` test
- Copy from (precedent): `apps/erp/app/routes/x+/production+/machine-time.tsx`, `machine-time.$id.tsx`, `apps/erp/app/modules/production/ui/MachineTime/MachineTimeTable.ee.tsx`, `MachineTimeDrawer.ee.tsx`, `MachineTimeUpgradeOverlay.ee.tsx`

**Steps:**
1. Copy each precedent file. Rename "machine time" to "machine count".
2. Table columns: Work Center, Start, End, Quantity, Scrap, Reason, Detail.
3. Show each reason as a label: NoLoad "No operation loaded", Blocked "Maintenance", OperationClosed "Operation done or canceled", OverTarget "Over the target quantity", SerialNeedsSendEachPulse "Serial item needs Send each pulse immediately", NoScrapReason "No scrap reason set", Refused "Refused".
4. The drawer assigns the row to an operation (same operation picker as the machine time drawer) or dismisses it.
5. Use `usePlanGate({ feature: "INTEGRATIONS" })` and the upgrade overlay exactly as `machine-time.tsx` does.

**Verify:**
```bash
bash -c 'cd apps/erp && npx react-router typegen && npx tsc --noEmit' 2>&1 | grep -v vitest
# Expected: no errors outside vitest.config.ts (a broken local symlink; see the parent plan)
```
Browser check in Task 17.

**Out of scope:** suggestions for the drawer (the machine time drawer's suggestion cards are not copied).

## Task 12: MES — refuse a manual Log completed in Auto mode

**Depends on:** Task 5
**Files:**
- Modify: `apps/mes/app/services/operations.service.ts` — `getWorkCenterCountMode(client, { workCenterId, companyId })`
- Modify: `apps/mes/app/services/models.ts` — `completeQuantityValidator` gets `override: zfd.checkbox()`
- Modify: `apps/mes/app/routes/x+/complete.tsx` — the refusal
- Modify: `apps/mes/app/routes/x+/operation.$operationId.tsx` — load `countMode` and `canOverrideCount`
- Modify: `apps/mes/app/components/JobOperation/components/QuantityModal.tsx` — notice and override checkbox for type `complete`
- Copy from (precedent): the `canOverrideComplete` loader in `apps/mes/app/routes/x+/assembly.$operationId.tsx:60-79`; the permission refusal in `complete.tsx:331-339`

**Steps:**
1. In `complete.tsx`, after the operation read, call `getWorkCenterCountMode`.
2. If it is `Auto` and `override` is false, return the refusal flash: "This work center logs completed quantities from its sensor."
3. If `override` is true, refuse unless the user holds `production` `delete` and `notes` is not empty: "An override needs the supervisor permission and a note."
4. In the modal, when `countMode === "Auto"` and the type is `complete`, show the first message as a notice.
5. Show an "Override (supervisor)" checkbox only when `canOverrideCount`.
6. Scrap and rework stay as they are.

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=mes
# Expected: no errors
```
Browser check in Task 17.

**Out of scope:** `end.$operationId.tsx` (QR completion): refuse it the same way only if it is a one-line change; else list it in the run notes.

## Task 13: MES — "Counted by the sensor" on Log scrap

**Depends on:** Task 5
**Files:**
- Modify: `apps/mes/app/services/models.ts` — `scrapQuantityValidator` gets `countedBySensor: zfd.checkbox()`
- Modify: `apps/mes/app/routes/x+/scrap.tsx`
- Modify: `apps/mes/app/components/JobOperation/components/QuantityModal.tsx` — the checkbox for type `scrap`, on by default in Auto, hidden for serial
- Copy from (precedent): `scrap.tsx` itself (refusal and success shape)

**Steps:**
1. If `countedBySensor` is true and the operation is not serial, open a Kysely transaction.
2. Call `lowerSensorProduction` for `quantity`.
3. If it lowered less than `quantity`, roll back and refuse: "The sensor has not counted that many pieces on this operation."
4. Commit, then post the scrap as today.
5. If the scrap posting fails, call `restoreSensorProduction` with the returned changes.

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=mes
# Expected: no errors
```
Browser check in Task 17.

**Out of scope:** serial scrap in the MES (the operator names the unit; unchanged).

## Task 14: Translations

**Depends on:** Tasks 9, 11, 12, 13
**Steps:**
1. Run `pnpm run lingui:extract`.
2. Run `pnpm run lingui:clean`.
3. Run `/translate` for the new strings only (as on 2026-11-15: filter the jobs to the new msgids).

**Verify:**
```bash
git diff --no-color packages/locale/locales | grep -E '^\+msgid' | wc -l
# Expected: the count of new strings; each has a filled msgstr in all 12 locales
```

## Task 15: Scoped gates

**Depends on:** Tasks 3–14
**Steps:**
1. Run each command below.
2. Fix each failure that comes from this branch.
3. List each failure that also fails on a clean tree in the run notes. Known: `apps/erp` `vitest.config.ts` (broken `@lingui/vite-plugin` symlink), `@carbon/checks` license-files tests, `no-raw-rounding` in `AssemblyBomTree.tsx`.

**Verify:**
```bash
pnpm --filter pulse-ingest test && pnpm --filter @carbon/ee test && pnpm --filter @carbon/jobs test
pnpm --filter @carbon/database exec vitest run src/machine-counts.test.ts src/authz
pnpm exec turbo run typecheck --filter=mes --filter=@carbon/ee --filter=@carbon/jobs --filter=@carbon/printing --concurrency=1
bash -c 'NODE_OPTIONS=--max-old-space-size=6144 bash packages/dev/bin/heavy-lock npx tsx scripts/generate-mcp.ts && cd apps/erp && npx react-router typegen && bash ../../packages/dev/bin/heavy-lock npx tsc --noEmit'
pnpm exec biome check <changed files>
pnpm --filter @carbon/checks license-headers --check
pnpm db:check:datasets && pnpm db:check:backups
# Expected: all pass, except the known clean-tree failures
```

## Task 16: Docs

**Depends on:** Task 15
**Files:**
- Modify: `.ai/specs/2026-11-14-pulse-machine-monitoring.md` — the Phase 3 data model and the "Decisions made while planning" above
- Modify: `.claude/rules/oee-provider.md` — a "Machine counts" section (count step, planner, poster, cursor, Unattributed Counts, MES Auto mode)
- Modify: `packages/ee/AGENTS.md` — `./oee` (`planMachineCounts`) and `./oee.server` (`postMachineCounts`, the counting and Unattributed Counts writes)
- Modify: `packages/database/AGENTS.md` — `./machine-counts`
- Modify: `apps/erp/app/modules/production/AGENTS.md` — Unattributed Counts
- Modify: `.ai/plans/2026-11-14-pulse-machine-monitoring.md` — tick Phase 3

**Steps:**
1. Write each change in STE-80.
2. Do the STE-80 review pass on the spec and the rule.

**Verify:**
```bash
git diff --stat .ai .claude packages/ee/AGENTS.md packages/database/AGENTS.md apps/erp/app/modules/production/AGENTS.md
# Expected: the 6 files changed
```

## Task 17: End-to-end check with the simulator and the browser

**Depends on:** Task 16
**Steps:**
1. Start the stack with `crbn up` (Inngest included). Start ingest and the simulator (`oee-provider.md` → "Local check without hardware").
2. Map `sim-cnc` to a work center. Set count mode Auto, a scrap reason, and "Print a label every 10 pieces".
3. Start a job operation of an untracked item on that work center in the MES.
4. Run the 10 checks below. After each, read the rows with `psql`.
5. Use `/test` for the browser parts (ERP Counting form, Unattributed Counts page, MES notice and override, MES scrap checkbox).

| # | Action | Expected |
|---|---|---|
| 1 | 500 strokes at `piecesPerPulse` 2 | `quantityComplete` +1000; the material issued once |
| 2 | 10 Log scrap presses in the same batch | Production +980, Scrap +20 |
| 3 | 5 Log scrap presses after the strokes posted | Production −10, Scrap +10; no extra material issue |
| 4 | Manual Log completed in the MES | Refused; a supervisor override with a note posts |
| 5 | MES Log scrap 3, "Counted by the sensor" on | Production −3, Scrap +3 |
| 6 | Strokes past the target | The operation is Done; the rest is in Unattributed Counts (Over the target quantity) |
| 7 | Strokes with no operation loaded | Unattributed Counts (No operation loaded); assign it from the drawer and it posts |
| 8 | Batch item, label every 10 | One print-job per 10 pieces |
| 9 | Serial item on `sim-tig` with Send each pulse immediately | One unit and one print-job per stroke within a few seconds; a Log scrap press scraps the last unit and spawns a replacement |
| 10 | Send last bucket again; Drop network and Restore | No extra posting |

**Verify:** every row of the table holds. Record the results in `.ai/runs/2026-11-16-pulse-phase3.md`.

## Run notes

- 2026-11-16: Tasks 1 and 2 were committed together: the migration alone
  fails the authz sync until the manifest has the two tables' rules.
- 2026-11-16: `planMachineCounts` keeps its own `contains` on epoch
  milliseconds instead of exporting the engine's, to avoid building an ISO
  string from a `Date` (the date rule).
- 2026-11-16: The QR / kanban Complete scan (`end.$operationId.tsx`) also
  refuses on a work center in Auto, so the rule holds on every server path.
- 2026-11-16: Unattributed Counts has no date filters (the table has no
  location-day view); it filters on work center, location and reason.
- 2026-11-16: Gates. Pass: pulse-ingest, the ee and jobs tests of this
  work, `machine-counts.test.ts`, every scoped typecheck including the ERP,
  license headers, datasets, backups. Fail on code this branch does not
  touch: `authz/sync.test.ts` (local `must be owner of function
  assert_company_access`), `purge-company.integration.test.ts` (a dangling
  `jobFavorite(jobId) -> job`), two Ramp staging integration tests and
  `pegging/peg-writer.write.test.ts`.
- 2026-11-16: On Windows, `pnpm install` fails in the root postinstall
  (cmd.exe), and it rewrote unrelated `pnpm-lock.yaml` entries; only the
  `packages/printing` importer hunks were committed.
