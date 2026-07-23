-- Deleting an ability definition should detach it from work centers, not
-- delete the work centers themselves (the original FK was ON DELETE CASCADE).
ALTER TABLE "workCenter" DROP CONSTRAINT "workCenter_requiredAbilityId_fkey";
ALTER TABLE "workCenter" ADD CONSTRAINT "workCenter_requiredAbilityId_fkey"
  FOREIGN KEY ("requiredAbilityId") REFERENCES "ability" ("id") ON DELETE SET NULL;
