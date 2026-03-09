-- Remove Messaging from the permission system.
-- Messaging was never used as a permission check anywhere in the application.
-- The enum value is left in place to avoid cascading ALTER TYPE issues.

-- 1. Strip messaging_* keys from userPermission JSONB
UPDATE "userPermission"
SET "permissions" = "permissions" - 'messaging_view' - 'messaging_create' - 'messaging_update' - 'messaging_delete'
WHERE "permissions" ?| ARRAY['messaging_view', 'messaging_create', 'messaging_update', 'messaging_delete'];

-- 2. Delete any employeeTypePermission rows for Messaging
DELETE FROM "employeeTypePermission" WHERE "module" = 'Messaging';
