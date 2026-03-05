-- Clean up orphaned employee memberships:
-- Users still in employee-type groups but no longer having an employee record
DELETE FROM membership m
WHERE m."memberUserId" IS NOT NULL
AND EXISTS (
  SELECT 1 FROM "group" g
  WHERE g.id = m."groupId"
  AND g."isEmployeeTypeGroup" = true
)
AND NOT EXISTS (
  SELECT 1 FROM employee e
  WHERE e.id = m."memberUserId"
);
