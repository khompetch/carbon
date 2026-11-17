-- OEE needs a year of machine state history (spec
-- .ai/specs/2026-11-14-oee-dashboard.md). Keep the rows of an unmapped or
-- remapped device too: they still hold the work center's run time.
CREATE OR REPLACE FUNCTION util.purge_machine_state_changes()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM "machineStateChange"
  WHERE "changedAt" < NOW() - INTERVAL '400 days';
$$;

REVOKE ALL ON FUNCTION util.purge_machine_state_changes() FROM PUBLIC;

-- The OEE reads Machine events and quantities by work center and time.
CREATE INDEX IF NOT EXISTS "productionEvent_workCenterId_startTime_idx"
  ON "productionEvent" ("workCenterId", "startTime")
  WHERE "type" = 'Machine';

CREATE INDEX IF NOT EXISTS "productionQuantity_companyId_createdAt_idx"
  ON "productionQuantity" ("companyId", "createdAt");
