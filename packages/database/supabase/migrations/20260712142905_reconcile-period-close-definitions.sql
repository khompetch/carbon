-- Reconcile every existing company's period-close checklist with the current
-- seed. 20260702044133 seeded the original 9-task set; this branch:
--   * dropped "Close the period" (redundant with the modal's Close button),
--   * reclassified "Review negative on-hand inventory" from an always-failing
--     Auto stub to a manual Action task (Mark done / Skip),
--   * reclassified "Review financial statements" from Manual to Action.
-- New companies get the corrected set from the seed-company edge function; this
-- brings existing companies in line.
--
-- No real company has general-ledger postings yet, so instantiated
-- periodCloseTask rows carry no close state worth preserving — reset them so
-- they re-instantiate from the corrected definitions the next time a checklist
-- is opened.
--
-- Idempotent: the delete is a no-op when already empty, the upsert reasserts the
-- canonical rows on every run, and dropping "Close the period" is a no-op once
-- it's gone.

-- 1. Reset instantiated tasks (they re-create from the definitions on next open,
--    picking up the corrected taskType / severity / autoCheckKey).
DELETE FROM "periodCloseTask";

-- 2. Drop the removed "Close the period" system definition.
DELETE FROM "periodCloseTaskDefinition"
WHERE "isSystem" = true AND "name" = 'Close the period';

-- 3. Upsert the canonical system definitions for every company — corrects
--    taskType / severity / autoCheckKey on existing rows and inserts any that
--    are missing. Guarded on the 'system' user for the createdBy FK.
INSERT INTO "periodCloseTaskDefinition"
  ("companyId", "name", "taskType", "autoCheckKey", "sortOrder", "required", "severity", "active", "isSystem", "createdBy")
SELECT
  c."id", d."name", d."taskType", d."autoCheckKey", d."sortOrder", d."required", d."severity", true, true, 'system'
FROM "company" c
CROSS JOIN (
  VALUES
    ('Post pending operational documents',          'Auto',   'pending-postings',   1, true,  'Blocker'),
    ('Post or re-date draft journal entries',       'Auto',   'draft-journals',     2, true,  'Blocker'),
    ('Lock the period',                             'Action', NULL,                 3, true,  NULL),
    ('Post depreciation runs covering the period',  'Auto',   'draft-depreciation', 4, true,  'Warning'),
    ('Match & eliminate intercompany transactions', 'Auto',   'unmatched-ic',       5, true,  'Warning'),
    ('Review negative on-hand inventory',           'Action', NULL,                 6, true,  NULL),
    ('Trial balance in balance for the period',     'Auto',   'tb-balanced',        7, true,  'Blocker'),
    ('Review financial statements',                 'Action', NULL,                 8, true,  NULL)
) AS d("name", "taskType", "autoCheckKey", "sortOrder", "required", "severity")
WHERE EXISTS (SELECT 1 FROM "user" u WHERE u."id" = 'system')
ON CONFLICT ("companyId", "name") DO UPDATE SET
  "taskType" = EXCLUDED."taskType",
  "autoCheckKey" = EXCLUDED."autoCheckKey",
  "sortOrder" = EXCLUDED."sortOrder",
  "required" = EXCLUDED."required",
  "severity" = EXCLUDED."severity",
  "active" = true,
  "isSystem" = true;
