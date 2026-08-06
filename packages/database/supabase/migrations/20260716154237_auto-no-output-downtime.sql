-- Auto no-output downtime: when a work center has an open production event
-- but no production quantity logged within X × cycle time, a background job
-- flags it as Unplanned downtime with a configured default reason.

-- Company-wide default multiplier (NULL = feature off) + default reason.
-- companySettings is one-row-per-company keyed on id = companyId, so the
-- composite FK to downtimeReason uses (autoDowntimeReasonId, id).
ALTER TABLE "companySettings"
  ADD COLUMN "autoDowntimeMultiplier" NUMERIC,
  ADD COLUMN "autoDowntimeReasonId" TEXT;

ALTER TABLE "companySettings"
  ADD CONSTRAINT "companySettings_autoDowntimeReasonId_fkey"
  FOREIGN KEY ("autoDowntimeReasonId", "id")
  REFERENCES "downtimeReason"("id", "companyId")
  ON DELETE SET NULL ("autoDowntimeReasonId");

-- Per-work-center override: NULL = inherit company default, 0 = disabled
ALTER TABLE "workCenter"
  ADD COLUMN "autoDowntimeMultiplier" NUMERIC;

-- The workCenter views expand wc.* at creation time — recreate them so the
-- new column is visible (definitions copied from 20260524143827_fixed-assets.sql)
DROP VIEW IF EXISTS "workCenters";
CREATE OR REPLACE VIEW "workCenters" WITH(SECURITY_INVOKER=true) AS
  SELECT
     wc.*,
     l.name as "locationName",
     d.name as "departmentName",
     wcp.processes
  FROM "workCenter" wc
  LEFT JOIN "location" l
    ON wc."locationId" = l.id
  LEFT JOIN "department" d
    ON wc."departmentId" = d.id
  LEFT JOIN (
    SELECT
      "workCenterId",
      array_agg("processId"::text) as processes
    FROM "workCenterProcess" wcp
    INNER JOIN "process" p ON wcp."processId" = p.id
    GROUP BY "workCenterId"
  ) wcp ON wc.id = wcp."workCenterId";

DROP VIEW IF EXISTS "workCentersWithBlockingStatus";
CREATE OR REPLACE VIEW "workCentersWithBlockingStatus" WITH (security_invoker = true) AS
SELECT
  wc.*,
  l.name AS "locationName",
  COALESCE(
    (SELECT COUNT(*) > 0
     FROM "maintenanceDispatch" md
     WHERE md."workCenterId" = wc.id
       AND md.status = 'In Progress'
       AND md."oeeImpact" IN ('Down', 'Planned')
    ), false
  ) AS "isBlocked",
  (
    SELECT md.id
    FROM "maintenanceDispatch" md
    WHERE md."workCenterId" = wc.id
      AND md.status = 'In Progress'
      AND md."oeeImpact" IN ('Down', 'Planned')
    ORDER BY md."createdAt" DESC
    LIMIT 1
  ) AS "blockingDispatchId",
  (
    SELECT md."maintenanceDispatchId"
    FROM "maintenanceDispatch" md
    WHERE md."workCenterId" = wc.id
      AND md.status = 'In Progress'
      AND md."oeeImpact" IN ('Down', 'Planned')
    ORDER BY md."createdAt" DESC
    LIMIT 1
  ) AS "blockingDispatchReadableId"
FROM "workCenter" wc
LEFT JOIN "location" l ON wc."locationId" = l.id;

-- Distinguish auto-flagged downtime from operator-recorded downtime: output
-- logging only auto-closes auto rows; manual rows end via the operator or a
-- production event start.
ALTER TABLE "workCenterDowntime"
  ADD COLUMN "isAuto" BOOLEAN NOT NULL DEFAULT FALSE;
