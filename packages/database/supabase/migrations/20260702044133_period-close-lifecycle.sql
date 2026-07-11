-- Period close lifecycle: Open → Locked → Closed on accountingPeriod,
-- fiscal-year identity, and a hard trigger backstop on journal.
-- Tracking spec: .ai/specs/2026-07-02-period-closing.md

-- 1. Close lifecycle enum (separate axis from the legacy Active/Inactive status)
DO $$ BEGIN
  CREATE TYPE "periodCloseStatus" AS ENUM ('Open', 'Locked', 'Closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. New columns
ALTER TABLE "accountingPeriod"
  ADD COLUMN IF NOT EXISTS "closeStatus" "periodCloseStatus" NOT NULL DEFAULT 'Open',
  ADD COLUMN IF NOT EXISTS "fiscalYear" INTEGER,
  ADD COLUMN IF NOT EXISTS "periodNumber" INTEGER,
  ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS "lockedBy" TEXT REFERENCES "user"("id") ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS "accountingPeriod_lockedBy_idx" ON "accountingPeriod" ("lockedBy");

-- 3. Backfill closeStatus from closedAt (column existed but was never populated;
--    be safe in case any environment has data)
UPDATE "accountingPeriod"
SET "closeStatus" = 'Closed'
WHERE "closedAt" IS NOT NULL AND "closeStatus" = 'Open';

-- 4. Backfill fiscalYear/periodNumber from the period's own startDate and the
--    company's fiscal start month. Fiscal years are named by the calendar year
--    in which they END (a FY starting Jul 2025 is FY2026); for January starts
--    the fiscal year equals the calendar year.
UPDATE "accountingPeriod" ap
SET
  "periodNumber" = ((EXTRACT(MONTH FROM ap."startDate")::int - s.start_month + 12) % 12) + 1,
  "fiscalYear" = CASE
    WHEN s.start_month = 1 THEN EXTRACT(YEAR FROM ap."startDate")::int
    WHEN EXTRACT(MONTH FROM ap."startDate")::int >= s.start_month THEN EXTRACT(YEAR FROM ap."startDate")::int + 1
    ELSE EXTRACT(YEAR FROM ap."startDate")::int
  END
FROM (
  SELECT
    c."id" AS company_id,
    COALESCE(
      (SELECT array_position(enum_range(NULL::"month")::text[], fys."startMonth"::text)
       FROM "fiscalYearSettings" fys
       WHERE fys."companyId" = c."id"),
      1
    ) AS start_month
  FROM "company" c
) s
WHERE s.company_id = ap."companyId"
  AND (ap."fiscalYear" IS NULL OR ap."periodNumber" IS NULL);

-- 5. Uniqueness of (companyId, fiscalYear, periodNumber). The lazy period
--    auto-creation has a historical race that could have produced duplicate
--    months; fall back to a plain index rather than failing the deploy.
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "accountingPeriod_company_fy_period_idx"
    ON "accountingPeriod" ("companyId", "fiscalYear", "periodNumber");
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'Duplicate (companyId, fiscalYear, periodNumber) rows exist; creating non-unique index instead';
  CREATE INDEX IF NOT EXISTS "accountingPeriod_company_fy_period_idx"
    ON "accountingPeriod" ("companyId", "fiscalYear", "periodNumber");
END $$;

-- 6. Hard backstop: nothing enters, leaves, or gets posted into a Closed
--    period. Locked-period semantics (who may post) require actor identity and
--    are enforced at the service layer; this trigger only guards the invariant
--    that Closed-period financials never change. Posted → Reversed status flips
--    are intentionally allowed (the offsetting entry lands in an open period).
CREATE OR REPLACE FUNCTION public.check_accounting_period_open()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_new_status "periodCloseStatus";
  v_old_status "periodCloseStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'Draft' THEN
      SELECT "closeStatus" INTO v_old_status
      FROM "accountingPeriod"
      WHERE ("id" = OLD."accountingPeriodId")
         OR (OLD."accountingPeriodId" IS NULL
             AND "companyId" = OLD."companyId"
             AND OLD."postingDate" BETWEEN "startDate" AND "endDate")
      LIMIT 1;
      IF v_old_status = 'Closed' THEN
        RAISE EXCEPTION 'Cannot delete journal %: accounting period is closed', OLD."id";
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  -- Skip UPDATEs that neither move the journal between periods nor post a draft
  IF TG_OP = 'UPDATE'
     AND NEW."postingDate" IS NOT DISTINCT FROM OLD."postingDate"
     AND NEW."accountingPeriodId" IS NOT DISTINCT FROM OLD."accountingPeriodId"
     AND NOT (OLD."status" = 'Draft' AND NEW."status" = 'Posted') THEN
    RETURN NEW;
  END IF;

  -- Moving a journal OUT of a closed period changes closed financials too
  IF TG_OP = 'UPDATE'
     AND (NEW."postingDate" IS DISTINCT FROM OLD."postingDate"
          OR NEW."accountingPeriodId" IS DISTINCT FROM OLD."accountingPeriodId") THEN
    SELECT "closeStatus" INTO v_old_status
    FROM "accountingPeriod"
    WHERE ("id" = OLD."accountingPeriodId")
       OR (OLD."accountingPeriodId" IS NULL
           AND "companyId" = OLD."companyId"
           AND OLD."postingDate" BETWEEN "startDate" AND "endDate")
    LIMIT 1;
    IF v_old_status = 'Closed' THEN
      RAISE EXCEPTION 'Cannot move journal % out of a closed accounting period', OLD."id";
    END IF;
  END IF;

  SELECT "closeStatus" INTO v_new_status
  FROM "accountingPeriod"
  WHERE ("id" = NEW."accountingPeriodId")
     OR (NEW."accountingPeriodId" IS NULL
         AND "companyId" = NEW."companyId"
         AND NEW."postingDate" BETWEEN "startDate" AND "endDate")
  LIMIT 1;

  IF v_new_status = 'Closed' THEN
    RAISE EXCEPTION 'Accounting period is closed for posting date %', NEW."postingDate";
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "journal_check_period_open" ON "journal";
CREATE TRIGGER "journal_check_period_open"
  BEFORE INSERT OR DELETE OR UPDATE OF "postingDate", "accountingPeriodId", "status" ON "journal"
  FOR EACH ROW EXECUTE FUNCTION public.check_accounting_period_open();
