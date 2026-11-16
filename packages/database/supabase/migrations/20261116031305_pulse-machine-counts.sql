-- Pulse Phase 3: the sensor posts Log completed and Log scrap on the
-- operation loaded on the work center.
--
-- workCenterDevice gets the counting settings of a mapping. machineCountPosting
-- holds one row per productionQuantity row the sensor makes, so a retry never
-- posts twice and a later Log scrap finds what the sensor completed.
-- unattributedMachineCount holds counts no operation could take, for a
-- supervisor to assign or dismiss.

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

-- 1. The counting settings of a mapping.
ALTER TABLE "workCenterDevice"
  ADD COLUMN IF NOT EXISTS "countMode" "machineCountMode" NOT NULL DEFAULT 'Off',
  -- The receivedAt of the newest pulseCount row the count step has read.
  ADD COLUMN IF NOT EXISTS "countedThrough" TIMESTAMP WITH TIME ZONE,
  -- The scrap reason of the device's Log scrap push switch.
  ADD COLUMN IF NOT EXISTS "scrapReasonId" TEXT,
  -- Batch items: print the lot label again every N pieces.
  ADD COLUMN IF NOT EXISTS "labelEveryQuantity" NUMERIC;

ALTER TABLE "workCenterDevice" DROP CONSTRAINT IF EXISTS "workCenterDevice_labelEveryQuantity_check";
ALTER TABLE "workCenterDevice" ADD CONSTRAINT "workCenterDevice_labelEveryQuantity_check"
  CHECK ("labelEveryQuantity" IS NULL OR "labelEveryQuantity" > 0);

ALTER TABLE "workCenterDevice" DROP CONSTRAINT IF EXISTS "workCenterDevice_scrapReasonId_fkey";
ALTER TABLE "workCenterDevice" ADD CONSTRAINT "workCenterDevice_scrapReasonId_fkey"
  FOREIGN KEY ("scrapReasonId") REFERENCES "scrapReason"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "workCenterDevice_scrapReasonId_idx"
  ON "workCenterDevice" ("scrapReasonId");

-- 2. One row per productionQuantity row the sensor makes.
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
  CONSTRAINT "machineCountPosting_jobOperationId_fkey" FOREIGN KEY ("jobOperationId")
    REFERENCES "jobOperation"("id") ON DELETE CASCADE,
  CONSTRAINT "machineCountPosting_trackedEntityId_fkey" FOREIGN KEY ("trackedEntityId")
    REFERENCES "trackedEntity"("id") ON DELETE SET NULL,
  CONSTRAINT "machineCountPosting_productionQuantityId_fkey" FOREIGN KEY ("productionQuantityId")
    REFERENCES "productionQuantity"("id") ON DELETE SET NULL,
  CONSTRAINT "machineCountPosting_quantity_check" CHECK ("quantity" > 0),
  CONSTRAINT "machineCountPosting_period_check" CHECK ("periodEnd" >= "periodStart")
);

CREATE INDEX IF NOT EXISTS "machineCountPosting_companyId_idx"
  ON "machineCountPosting" ("companyId");
CREATE INDEX IF NOT EXISTS "machineCountPosting_workCenterId_idx"
  ON "machineCountPosting" ("workCenterId");
CREATE INDEX IF NOT EXISTS "machineCountPosting_jobOperationId_idx"
  ON "machineCountPosting" ("jobOperationId", "createdAt");
CREATE INDEX IF NOT EXISTS "machineCountPosting_trackedEntityId_idx"
  ON "machineCountPosting" ("trackedEntityId");
CREATE INDEX IF NOT EXISTS "machineCountPosting_productionQuantityId_idx"
  ON "machineCountPosting" ("productionQuantityId");
CREATE INDEX IF NOT EXISTS "machineCountPosting_pending_idx"
  ON "machineCountPosting" ("workCenterId") WHERE "status" = 'Pending';
CREATE INDEX IF NOT EXISTS "machineCountPosting_createdBy_idx"
  ON "machineCountPosting" ("createdBy");
CREATE INDEX IF NOT EXISTS "machineCountPosting_updatedBy_idx"
  ON "machineCountPosting" ("updatedBy");

-- 3. Counts no operation could take. A supervisor assigns or dismisses them.
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
  -- The operation the counts were meant for, when there was one.
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
  CONSTRAINT "unattributedMachineCount_jobOperationId_fkey" FOREIGN KEY ("jobOperationId")
    REFERENCES "jobOperation"("id") ON DELETE SET NULL,
  CONSTRAINT "unattributedMachineCount_quantity_check"
    CHECK ("quantity" >= 0 AND "scrapQuantity" >= 0 AND "quantity" + "scrapQuantity" > 0),
  CONSTRAINT "unattributedMachineCount_period_check" CHECK ("periodEnd" >= "periodStart")
);

CREATE INDEX IF NOT EXISTS "unattributedMachineCount_companyId_idx"
  ON "unattributedMachineCount" ("companyId");
CREATE INDEX IF NOT EXISTS "unattributedMachineCount_workCenterId_idx"
  ON "unattributedMachineCount" ("workCenterId", "periodStart");
CREATE INDEX IF NOT EXISTS "unattributedMachineCount_jobOperationId_idx"
  ON "unattributedMachineCount" ("jobOperationId");
CREATE INDEX IF NOT EXISTS "unattributedMachineCount_createdBy_idx"
  ON "unattributedMachineCount" ("createdBy");
CREATE INDEX IF NOT EXISTS "unattributedMachineCount_updatedBy_idx"
  ON "unattributedMachineCount" ("updatedBy");

-- 4. A load stays while the count step may still read a late bucket for it:
--    a device in Auto that has not counted past the unload keeps it.
CREATE OR REPLACE FUNCTION util.purge_work_center_loads()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM "workCenterLoad" l
  WHERE l."unloadedAt" < NOW() - INTERVAL '7 days'
    AND NOT EXISTS (
      SELECT 1 FROM "workCenterDevice" d
      WHERE d."workCenterId" = l."workCenterId"
        AND d."companyId" = l."companyId"
        AND (
          d."appliedThrough" IS NULL
          OR d."appliedThrough" < l."unloadedAt"
          OR (
            d."countMode" = 'Auto'
            AND (d."countedThrough" IS NULL OR d."countedThrough" < l."unloadedAt")
          )
        )
    );
$$;

REVOKE ALL ON FUNCTION util.purge_work_center_loads() FROM PUBLIC;

-- 5. Posted rows and old unattributed counts are history: keep 90 days.
CREATE OR REPLACE FUNCTION util.purge_machine_counts()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM "machineCountPosting"
  WHERE "status" = 'Posted' AND "createdAt" < NOW() - INTERVAL '90 days';
  DELETE FROM "unattributedMachineCount"
  WHERE "periodEnd" < NOW() - INTERVAL '90 days';
$$;

REVOKE ALL ON FUNCTION util.purge_machine_counts() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'machine-count-retention'
  ) THEN
    PERFORM cron.unschedule('machine-count-retention');
  END IF;
  PERFORM cron.schedule(
    'machine-count-retention',
    '47 4 * * *',
    'SELECT util.purge_machine_counts();'
  );
END;
$$;
