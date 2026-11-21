-- Stop reasons and logged operation stops: the MES "Log stop" button records
-- why an operation stopped, and the reason's oeeLoss says which of the Six
-- Big Losses the stop counts toward.
CREATE TYPE "oeeLoss" AS ENUM (
  'Breakdown',
  'Setup & Adjustment',
  'Small Stop'
);

CREATE TABLE "stopReason" (
  "id" TEXT NOT NULL DEFAULT id('sr'),
  "companyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "oeeLoss" "oeeLoss" NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdBy" TEXT NOT NULL REFERENCES "user"("id"),
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedBy" TEXT REFERENCES "user"("id"),
  "updatedAt" TIMESTAMP WITH TIME ZONE,
  "customFields" JSONB,

  PRIMARY KEY ("id", "companyId"),
  UNIQUE ("id"),
  FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE
);

CREATE INDEX "stopReason_companyId_idx" ON "stopReason" ("companyId");
CREATE INDEX "stopReason_createdBy_idx" ON "stopReason" ("createdBy");
CREATE INDEX "stopReason_updatedBy_idx" ON "stopReason" ("updatedBy");

ALTER TABLE "stopReason" ADD CONSTRAINT "stopReason_companyId_name_key"
  UNIQUE ("companyId", "name");

ALTER TABLE "stopReason" ENABLE ROW LEVEL SECURITY;

CREATE TABLE "operationStop" (
  "id" TEXT NOT NULL DEFAULT id('ops'),
  "companyId" TEXT NOT NULL,
  "jobOperationId" TEXT NOT NULL REFERENCES "jobOperation"("id") ON DELETE CASCADE,
  "workCenterId" TEXT REFERENCES "workCenter"("id") ON DELETE SET NULL,
  "stopReasonId" TEXT NOT NULL REFERENCES "stopReason"("id") ON DELETE RESTRICT,
  "employeeId" TEXT NOT NULL REFERENCES "user"("id"),
  "startTime" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "endTime" TIMESTAMP WITH TIME ZONE,
  -- The Machine event the stop closed; Resume opens a new one like it
  "pausedMachineEventId" TEXT REFERENCES "productionEvent"("id") ON DELETE SET NULL,
  "notes" TEXT,
  "createdBy" TEXT NOT NULL REFERENCES "user"("id"),
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedBy" TEXT REFERENCES "user"("id"),
  "updatedAt" TIMESTAMP WITH TIME ZONE,

  PRIMARY KEY ("id", "companyId"),
  FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE,
  CONSTRAINT "operationStop_endTime_check"
    CHECK ("endTime" IS NULL OR "endTime" >= "startTime")
);

CREATE INDEX "operationStop_companyId_idx" ON "operationStop" ("companyId");
CREATE INDEX "operationStop_jobOperationId_idx" ON "operationStop" ("jobOperationId");
CREATE INDEX "operationStop_workCenterId_idx" ON "operationStop" ("workCenterId");
CREATE INDEX "operationStop_stopReasonId_idx" ON "operationStop" ("stopReasonId");
CREATE INDEX "operationStop_employeeId_idx" ON "operationStop" ("employeeId");
CREATE INDEX "operationStop_pausedMachineEventId_idx" ON "operationStop" ("pausedMachineEventId");
CREATE INDEX "operationStop_createdBy_idx" ON "operationStop" ("createdBy");
CREATE INDEX "operationStop_updatedBy_idx" ON "operationStop" ("updatedBy");

-- One open stop per operation
CREATE UNIQUE INDEX "operationStop_open_key"
  ON "operationStop" ("jobOperationId") WHERE "endTime" IS NULL;

ALTER TABLE "operationStop" ENABLE ROW LEVEL SECURITY;

-- Default stop reasons for existing companies; new companies get them from
-- seedCompany (packages/database/src/seed-data.ts stopReasons)
INSERT INTO "stopReason" ("companyId", "name", "oeeLoss", "createdBy")
SELECT c."id", r."name", r."oeeLoss"::"oeeLoss", 'system'
FROM "company" c
CROSS JOIN (VALUES
  ('Machine breakdown', 'Breakdown'),
  ('Tool failure', 'Breakdown'),
  ('Changeover', 'Setup & Adjustment'),
  ('Adjustment', 'Setup & Adjustment'),
  ('Minor jam', 'Small Stop'),
  ('Waiting for material', 'Small Stop')
) AS r("name", "oeeLoss")
ON CONFLICT ("companyId", "name") DO NOTHING;
