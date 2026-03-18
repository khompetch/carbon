-- Add a JSONB flags column to the user table for extensible boolean preferences
ALTER TABLE "user" ADD COLUMN "flags" JSONB NOT NULL DEFAULT '{}';

-- Migrate existing acknowledgedUniversity into the new flags column
UPDATE "user"
SET "flags" = jsonb_set("flags", '{academy}', 'true')
WHERE "acknowledgedUniversity" = true;

-- Drop the legacy column now that data lives in flags
ALTER TABLE "user" DROP COLUMN "acknowledgedUniversity";
