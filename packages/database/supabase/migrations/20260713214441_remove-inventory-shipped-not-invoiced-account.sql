-- Remove the "Inventory Shipped Not Invoiced" default account entirely.
--
-- It was seeded as a liability (2130) while the Account Defaults form filters
-- the field to assets, so it always rendered blank — and no posting code has
-- ever written to it (post-shipment posts COGS / inventory directly). Dead
-- config: drop the accountDefault column and delete the seeded account
-- wherever it has no journal history. Accounts that DO have journal lines or
-- are referenced by other custom config are left in the chart untouched —
-- admins can remove those themselves.
--
-- The name match covers both shapes in the wild: the original 2130 liability
-- and the short-lived 1250 asset reclass that only ever ran on dev branches.

-- ============================================================
-- Step 1: Drop the accountDefault column (config-only, no readers)
-- ============================================================

ALTER TABLE "accountDefault"
  DROP CONSTRAINT IF EXISTS "accountDefault_inventoryShippedNotInvoicedAccount_fkey";
ALTER TABLE "accountDefault"
  DROP COLUMN IF EXISTS "inventoryShippedNotInvoicedAccount";

-- ============================================================
-- Step 2: Delete the seeded account where it is unused
-- ============================================================
-- Guarded per row: skip accounts with journal history, and swallow FK
-- violations from any other reference (e.g. an admin wired it into other
-- custom config) — those rows simply stay in the chart.

DO $$
DECLARE
  v_account RECORD;
BEGIN
  FOR v_account IN
    SELECT a."id"
    FROM "account" a
    WHERE a."name" = 'Inventory Shipped Not Invoiced'
      AND a."isGroup" = false
      AND NOT EXISTS (
        SELECT 1 FROM "journalLine" jl WHERE jl."accountId" = a."id"
      )
  LOOP
    BEGIN
      DELETE FROM "account" WHERE "id" = v_account."id";
    EXCEPTION WHEN foreign_key_violation THEN
      -- still referenced somewhere (custom config) — leave it in the chart
      NULL;
    END;
  END LOOP;
END $$;
