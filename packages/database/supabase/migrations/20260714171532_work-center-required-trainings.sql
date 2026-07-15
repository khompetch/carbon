-- A work center can require multiple trainings (Resources → Training module).
-- Operators must hold a valid completion for every linked Active training to
-- start operations at the work center (enforced in MES).

CREATE TABLE "workCenterTraining" (
  "workCenterId" TEXT NOT NULL,
  "trainingId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  "createdBy" TEXT NOT NULL,

  CONSTRAINT "workCenterTraining_pkey" PRIMARY KEY ("workCenterId", "trainingId"),
  CONSTRAINT "workCenterTraining_workCenterId_fkey" FOREIGN KEY ("workCenterId") REFERENCES "workCenter"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workCenterTraining_trainingId_fkey" FOREIGN KEY ("trainingId") REFERENCES "training"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workCenterTraining_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workCenterTraining_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON UPDATE CASCADE
);

CREATE INDEX "workCenterTraining_companyId_idx" ON "workCenterTraining" ("companyId");
CREATE INDEX "workCenterTraining_trainingId_idx" ON "workCenterTraining" ("trainingId");

ALTER TABLE "workCenterTraining" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "SELECT" ON "public"."workCenterTraining"
FOR SELECT USING (
  "companyId" = ANY (
    (
      SELECT
        get_companies_with_employee_permission ('resources_view')
    )::text[]
  )
);

CREATE POLICY "INSERT" ON "public"."workCenterTraining"
FOR INSERT WITH CHECK (
  "companyId" = ANY (
    (
      SELECT
        get_companies_with_employee_permission ('resources_update')
    )::text[]
  )
);

CREATE POLICY "UPDATE" ON "public"."workCenterTraining"
FOR UPDATE USING (
  "companyId" = ANY (
    (
      SELECT
        get_companies_with_employee_permission ('resources_update')
    )::text[]
  )
);

CREATE POLICY "DELETE" ON "public"."workCenterTraining"
FOR DELETE USING (
  "companyId" = ANY (
    (
      SELECT
        get_companies_with_employee_permission ('resources_update')
    )::text[]
  )
);

-- Trainings the work center requires that the employee has NOT validly
-- completed: no completion at all, or (Quarterly/Annual) the completion is
-- for a previous period. Only Active trainings count as requirements.
-- Completion may come through any assignment of that training.
CREATE OR REPLACE FUNCTION get_missing_required_trainings(
  p_work_center_id TEXT,
  p_employee_id TEXT,
  p_company_id TEXT
)
RETURNS TABLE (
  "trainingId" TEXT,
  "name" TEXT
) LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT t.id, t.name
  FROM "workCenterTraining" wct
  JOIN "training" t ON t.id = wct."trainingId" AND t.status = 'Active'
  WHERE wct."workCenterId" = p_work_center_id
    AND wct."companyId" = p_company_id
    AND NOT EXISTS (
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
