-- Gate operation completion on required-step completion (process-level flag).
-- When "requireAllStepsToComplete" is true for a process, MES blocks Log Completed
-- and Finish on its operations until every "jobOperationStep" marked "required"
-- has at least one "jobOperationStepRecord". The "required" column already exists
-- on all step tables; this only adds the process-level toggle.
ALTER TABLE "process" ADD COLUMN IF NOT EXISTS "requireAllStepsToComplete" BOOLEAN NOT NULL DEFAULT false;

-- Recreate the processes view to include the new column
-- (PostgreSQL views with SELECT * don't auto-update when columns are added)
DROP VIEW IF EXISTS "processes";
CREATE OR REPLACE VIEW "processes" WITH(SECURITY_INVOKER=true) AS
  SELECT
    p.*,
    wcp."workCenters",
    sp."suppliers"
  FROM "process" p
  LEFT JOIN (
    SELECT
      "processId",
      array_agg("workCenterId"::text) as "workCenters"
    FROM "workCenterProcess" wcp
    INNER JOIN "workCenter" wc ON wcp."workCenterId" = wc.id
    GROUP BY "processId"
  ) wcp ON p.id = wcp."processId"
  LEFT JOIN (
    SELECT
      "processId",
      jsonb_agg(jsonb_build_object('id', sp."id", 'name', s.name)) as "suppliers"
    FROM "supplierProcess" sp
    INNER JOIN "supplier" s ON sp."supplierId" = s.id
    GROUP BY "processId"
  ) sp ON p.id = sp."processId";
