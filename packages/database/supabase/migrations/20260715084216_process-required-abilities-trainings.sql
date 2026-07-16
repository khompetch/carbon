-- Requirements can now also live on the process (type of work) — most skill
-- and training requirements follow the work, not the machine. MES enforces
-- the union of process-level and work-center-level requirements.

ALTER TABLE "process" ADD COLUMN "requiredAbilityId" TEXT;
ALTER TABLE "process" ADD CONSTRAINT "process_requiredAbilityId_fkey"
  FOREIGN KEY ("requiredAbilityId") REFERENCES "ability" ("id") ON DELETE SET NULL;

CREATE TABLE "processTraining" (
  "processId" TEXT NOT NULL,
  "trainingId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  "createdBy" TEXT NOT NULL,

  CONSTRAINT "processTraining_pkey" PRIMARY KEY ("processId", "trainingId"),
  CONSTRAINT "processTraining_processId_fkey" FOREIGN KEY ("processId") REFERENCES "process"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "processTraining_trainingId_fkey" FOREIGN KEY ("trainingId") REFERENCES "training"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "processTraining_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "processTraining_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON UPDATE CASCADE
);

CREATE INDEX "processTraining_companyId_idx" ON "processTraining" ("companyId");
CREATE INDEX "processTraining_trainingId_idx" ON "processTraining" ("trainingId");

ALTER TABLE "processTraining" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "SELECT" ON "public"."processTraining"
FOR SELECT USING (
  "companyId" = ANY (
    (
      SELECT
        get_companies_with_employee_permission ('resources_view')
    )::text[]
  )
);

CREATE POLICY "INSERT" ON "public"."processTraining"
FOR INSERT WITH CHECK (
  "companyId" = ANY (
    (
      SELECT
        get_companies_with_employee_permission ('resources_update')
    )::text[]
  )
);

CREATE POLICY "UPDATE" ON "public"."processTraining"
FOR UPDATE USING (
  "companyId" = ANY (
    (
      SELECT
        get_companies_with_employee_permission ('resources_update')
    )::text[]
  )
);

CREATE POLICY "DELETE" ON "public"."processTraining"
FOR DELETE USING (
  "companyId" = ANY (
    (
      SELECT
        get_companies_with_employee_permission ('resources_update')
    )::text[]
  )
);

-- Recreate with the process dimension: missing trainings are the union of the
-- work center's and the process's required Active trainings that the employee
-- has no period-valid completion for. Either id may be NULL.
DROP FUNCTION IF EXISTS get_missing_required_trainings(TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION get_missing_required_trainings(
  p_work_center_id TEXT,
  p_process_id TEXT,
  p_employee_id TEXT,
  p_company_id TEXT
)
RETURNS TABLE (
  "trainingId" TEXT,
  "name" TEXT
) LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  WITH required AS (
    SELECT wct."trainingId" AS id
    FROM "workCenterTraining" wct
    WHERE p_work_center_id IS NOT NULL
      AND wct."workCenterId" = p_work_center_id
      AND wct."companyId" = p_company_id
    UNION
    SELECT pt."trainingId" AS id
    FROM "processTraining" pt
    WHERE p_process_id IS NOT NULL
      AND pt."processId" = p_process_id
      AND pt."companyId" = p_company_id
  )
  SELECT t.id, t.name
  FROM required r
  JOIN "training" t ON t.id = r.id AND t.status = 'Active'
  WHERE NOT EXISTS (
    SELECT 1
    FROM "trainingCompletion" tc
    JOIN "trainingAssignment" ta ON ta.id = tc."trainingAssignmentId"
    WHERE ta."trainingId" = t.id
      AND tc."employeeId" = p_employee_id
      AND tc."companyId" = p_company_id
      AND (
        (t.frequency = 'Once' AND tc."period" IS NULL)
        OR tc."period" = get_current_training_period(t.frequency)
      )
  )
  ORDER BY t.name;
END;
$$;
