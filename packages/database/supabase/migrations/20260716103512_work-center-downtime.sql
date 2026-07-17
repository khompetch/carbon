-- Downtime recording for OEE: reasons (Planned/Unplanned) and per-work-center
-- downtime intervals. Powers the per-work-center hourly OEE board's PDT/UPDT
-- split alongside maintenanceDispatch.oeeImpact.

CREATE TYPE "downtimeType" AS ENUM ('Planned', 'Unplanned');

CREATE TABLE "downtimeReason" (
    "id" TEXT NOT NULL DEFAULT id('dtr'),
    "companyId" TEXT NOT NULL,

    "name" TEXT NOT NULL,
    "type" "downtimeType" NOT NULL DEFAULT 'Unplanned',
    "active" BOOLEAN NOT NULL DEFAULT TRUE,

    "createdBy" TEXT NOT NULL REFERENCES "user"("id"),
    "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    "updatedBy" TEXT REFERENCES "user"("id"),
    "updatedAt" TIMESTAMP WITH TIME ZONE,
    "customFields" JSONB,

    PRIMARY KEY ("id", "companyId"),
    FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE
);

CREATE INDEX "downtimeReason_companyId_idx" ON "downtimeReason" ("companyId");
CREATE INDEX "downtimeReason_createdBy_idx" ON "downtimeReason" ("createdBy");

ALTER TABLE "downtimeReason" ADD CONSTRAINT "downtimeReason_companyId_name_key"
    UNIQUE ("companyId", "name");

ALTER TABLE "public"."downtimeReason" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "SELECT" ON "public"."downtimeReason"
FOR SELECT USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_role())::text[])
);

CREATE POLICY "INSERT" ON "public"."downtimeReason"
FOR INSERT WITH CHECK (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('production_create'))::text[])
);

CREATE POLICY "UPDATE" ON "public"."downtimeReason"
FOR UPDATE USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('production_update'))::text[])
);

CREATE POLICY "DELETE" ON "public"."downtimeReason"
FOR DELETE USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('production_delete'))::text[])
);

CREATE TABLE "workCenterDowntime" (
    "id" TEXT NOT NULL DEFAULT id('wcd'),
    "companyId" TEXT NOT NULL,

    "workCenterId" TEXT NOT NULL,
    "downtimeReasonId" TEXT,
    -- Copied from the reason at record time so history survives reason edits
    "type" "downtimeType" NOT NULL DEFAULT 'Unplanned',
    "startTime" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    -- NULL = the work center is currently down
    "endTime" TIMESTAMP WITH TIME ZONE,
    "notes" TEXT,

    "createdBy" TEXT NOT NULL REFERENCES "user"("id"),
    "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    "updatedBy" TEXT REFERENCES "user"("id"),
    "updatedAt" TIMESTAMP WITH TIME ZONE,
    "customFields" JSONB,

    PRIMARY KEY ("id", "companyId"),
    FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE,
    FOREIGN KEY ("workCenterId") REFERENCES "workCenter"("id") ON DELETE CASCADE,
    FOREIGN KEY ("downtimeReasonId", "companyId") REFERENCES "downtimeReason"("id", "companyId") ON DELETE SET NULL ("downtimeReasonId")
);

CREATE INDEX "workCenterDowntime_companyId_workCenterId_startTime_idx"
    ON "workCenterDowntime" ("companyId", "workCenterId", "startTime");
CREATE INDEX "workCenterDowntime_open_idx"
    ON "workCenterDowntime" ("workCenterId") WHERE "endTime" IS NULL;
CREATE INDEX "workCenterDowntime_downtimeReasonId_idx" ON "workCenterDowntime" ("downtimeReasonId");
CREATE INDEX "workCenterDowntime_createdBy_idx" ON "workCenterDowntime" ("createdBy");

ALTER TABLE "public"."workCenterDowntime" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "SELECT" ON "public"."workCenterDowntime"
FOR SELECT USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_role())::text[])
);

CREATE POLICY "INSERT" ON "public"."workCenterDowntime"
FOR INSERT WITH CHECK (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('production_create'))::text[])
);

CREATE POLICY "UPDATE" ON "public"."workCenterDowntime"
FOR UPDATE USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('production_update'))::text[])
);

CREATE POLICY "DELETE" ON "public"."workCenterDowntime"
FOR DELETE USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('production_delete'))::text[])
);

-- Live OEE boards subscribe to downtime changes
ALTER TABLE "workCenterDowntime" REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE "workCenterDowntime";

-- Missing indexes for time-window-by-work-center OEE queries
CREATE INDEX "productionEvent_companyId_workCenterId_startTime_idx"
    ON "productionEvent" ("companyId", "workCenterId", "startTime");
CREATE INDEX "productionQuantity_companyId_createdAt_idx"
    ON "productionQuantity" ("companyId", "createdAt");
