-- Pulse: an in-house machine monitor, the second OEE provider after Sense
-- (plan: .ai/plans/2026-11-14-pulse-machine-monitoring.md).
--
-- A Pulse device counts one pulse per machine cycle and sends the counts over
-- MQTT. The ingest service (apps/pulse-ingest) stores them here and infers
-- the machine's state from them. The `pulse` provider reads these tables, and
-- the OEE sync turns the states into machine time exactly as it does for Sense.
--
-- Only the ingest service and the provider write these tables, through the
-- service role or a direct connection, so the API reads them only.

-- 1. The provider
INSERT INTO "integration" ("id", "jsonschema")
VALUES ('pulse', '{"type": "object", "properties": {}}'::json)
ON CONFLICT ("id") DO NOTHING;

UPDATE "integration" SET "providerRole" = 'oee'
  WHERE "id" = 'pulse' AND "providerRole" IS DISTINCT FROM 'oee';

-- 2. Devices
-- `deviceKey` is the MQTT username and the topic segment, so the broker's
-- namespace makes it unique on the whole server, not per company. It is the
-- `externalDeviceId` the Devices tab maps to a work center.
CREATE TABLE IF NOT EXISTS "pulseDevice" (
  "id" TEXT NOT NULL DEFAULT id('pdv'),
  "companyId" TEXT NOT NULL,
  "deviceKey" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "locationId" TEXT,
  -- Configuration
  "piecesPerPulse" NUMERIC NOT NULL DEFAULT 1,
  "expectedCycleSeconds" NUMERIC,
  "idleAfterSeconds" INTEGER,
  "offlineAfterSeconds" INTEGER NOT NULL DEFAULT 300,
  "debounceMs" INTEGER NOT NULL DEFAULT 20,
  "bucketSeconds" INTEGER NOT NULL DEFAULT 5,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  -- Health, written by the ingest service
  "lastSeenAt" TIMESTAMP WITH TIME ZONE,
  "lastPulseAt" TIMESTAMP WITH TIME ZONE,
  "lastCounter" BIGINT,
  "lastSeq" BIGINT,
  "bootId" TEXT,
  "rssi" INTEGER,
  "firmwareVersion" TEXT,
  "queueDepth" INTEGER,
  -- The inferred state, so a restarted ingest service resumes from it
  "currentState" "machineState",
  "currentStateAt" TIMESTAMP WITH TIME ZONE,
  "aliveSince" TIMESTAMP WITH TIME ZONE,
  "heartbeatCounter" BIGINT,
  "createdBy" TEXT NOT NULL REFERENCES "user"("id"),
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedBy" TEXT REFERENCES "user"("id"),
  "updatedAt" TIMESTAMP WITH TIME ZONE,
  CONSTRAINT "pulseDevice_pkey" PRIMARY KEY ("id", "companyId"),
  CONSTRAINT "pulseDevice_companyId_fkey" FOREIGN KEY ("companyId")
    REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pulseDevice_locationId_fkey" FOREIGN KEY ("locationId", "companyId")
    REFERENCES "location"("id", "companyId") ON DELETE SET NULL ("locationId"),
  CONSTRAINT "pulseDevice_deviceKey_key" UNIQUE ("deviceKey"),
  CONSTRAINT "pulseDevice_deviceKey_check"
    CHECK ("deviceKey" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT "pulseDevice_piecesPerPulse_check" CHECK ("piecesPerPulse" > 0),
  CONSTRAINT "pulseDevice_expectedCycleSeconds_check"
    CHECK ("expectedCycleSeconds" IS NULL OR "expectedCycleSeconds" > 0),
  CONSTRAINT "pulseDevice_idleAfterSeconds_check"
    CHECK ("idleAfterSeconds" IS NULL OR "idleAfterSeconds" > 0),
  CONSTRAINT "pulseDevice_offlineAfterSeconds_check"
    CHECK ("offlineAfterSeconds" > 0),
  CONSTRAINT "pulseDevice_debounceMs_check" CHECK ("debounceMs" >= 0),
  CONSTRAINT "pulseDevice_bucketSeconds_check" CHECK ("bucketSeconds" > 0)
);

CREATE INDEX IF NOT EXISTS "pulseDevice_companyId_idx" ON "pulseDevice" ("companyId");
CREATE INDEX IF NOT EXISTS "pulseDevice_locationId_idx" ON "pulseDevice" ("locationId");
CREATE INDEX IF NOT EXISTS "pulseDevice_createdBy_idx" ON "pulseDevice" ("createdBy");
CREATE INDEX IF NOT EXISTS "pulseDevice_updatedBy_idx" ON "pulseDevice" ("updatedBy");

-- 3. Counts: one row per bucket a device sent.
-- (bootId, seq) is the device's own message id, so a repeated MQTT delivery
-- inserts nothing. An estimated row holds the pulses of buckets that never
-- arrived, worked out from the lifetime counter; it carries the seq of the
-- bucket that revealed them.
CREATE TABLE IF NOT EXISTS "pulseCount" (
  "id" TEXT NOT NULL DEFAULT id('pct'),
  "companyId" TEXT NOT NULL,
  "pulseDeviceId" TEXT NOT NULL,
  "bootId" TEXT NOT NULL,
  "seq" BIGINT NOT NULL,
  "periodStart" TIMESTAMP WITH TIME ZONE NOT NULL,
  "periodEnd" TIMESTAMP WITH TIME ZONE NOT NULL,
  "pulses" INTEGER NOT NULL,
  "counter" BIGINT NOT NULL,
  "estimated" BOOLEAN NOT NULL DEFAULT FALSE,
  -- True when the device's wall clock was not used for the period.
  "rebased" BOOLEAN NOT NULL DEFAULT FALSE,
  "receivedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT "pulseCount_pkey" PRIMARY KEY ("id", "companyId"),
  CONSTRAINT "pulseCount_companyId_fkey" FOREIGN KEY ("companyId")
    REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pulseCount_pulseDeviceId_fkey" FOREIGN KEY ("pulseDeviceId", "companyId")
    REFERENCES "pulseDevice"("id", "companyId") ON DELETE CASCADE,
  CONSTRAINT "pulseCount_message_key"
    UNIQUE ("pulseDeviceId", "bootId", "seq", "estimated", "companyId"),
  CONSTRAINT "pulseCount_pulses_check" CHECK ("pulses" > 0),
  CONSTRAINT "pulseCount_period_check" CHECK ("periodEnd" >= "periodStart")
);

CREATE INDEX IF NOT EXISTS "pulseCount_companyId_idx" ON "pulseCount" ("companyId");
CREATE INDEX IF NOT EXISTS "pulseCount_device_periodEnd_idx"
  ON "pulseCount" ("pulseDeviceId", "periodEnd");
CREATE INDEX IF NOT EXISTS "pulseCount_receivedAt_idx" ON "pulseCount" ("receivedAt");

-- 4. Inferred state changes. The provider returns them to the OEE sync,
-- which copies them into machineStateChange. Down is never inferred: it comes
-- from a maintenance dispatch.
CREATE TABLE IF NOT EXISTS "pulseStateChange" (
  "id" TEXT NOT NULL DEFAULT id('psc'),
  "companyId" TEXT NOT NULL,
  "pulseDeviceId" TEXT NOT NULL,
  "state" "machineState" NOT NULL,
  "changedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT "pulseStateChange_pkey" PRIMARY KEY ("id", "companyId"),
  CONSTRAINT "pulseStateChange_companyId_fkey" FOREIGN KEY ("companyId")
    REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pulseStateChange_pulseDeviceId_fkey" FOREIGN KEY ("pulseDeviceId", "companyId")
    REFERENCES "pulseDevice"("id", "companyId") ON DELETE CASCADE,
  CONSTRAINT "pulseStateChange_change_key"
    UNIQUE ("pulseDeviceId", "changedAt", "state", "companyId"),
  CONSTRAINT "pulseStateChange_state_check" CHECK ("state" <> 'Down'),
  CONSTRAINT "pulseStateChange_reason_check"
    CHECK ("reason" IN ('pulse', 'idle', 'heartbeat'))
);

CREATE INDEX IF NOT EXISTS "pulseStateChange_companyId_idx" ON "pulseStateChange" ("companyId");
CREATE INDEX IF NOT EXISTS "pulseStateChange_device_changedAt_idx"
  ON "pulseStateChange" ("pulseDeviceId", "changedAt");
CREATE INDEX IF NOT EXISTS "pulseStateChange_changedAt_idx" ON "pulseStateChange" ("changedAt");

-- 5. The ingest service's own heartbeat: one row for the whole server, since
-- one ingest service serves every company. The provider's healthcheck reads it.
CREATE TABLE IF NOT EXISTS "pulseIngestStatus" (
  "id" TEXT NOT NULL DEFAULT 'ingest',
  "heartbeatAt" TIMESTAMP WITH TIME ZONE NOT NULL,
  "version" TEXT,
  CONSTRAINT "pulseIngestStatus_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pulseIngestStatus_id_check" CHECK ("id" = 'ingest')
);

-- 6. Retention. 400 days keeps a year of history for OEE. The OEE sync reads
-- only recent rows, so older ones are history, not working data.
CREATE OR REPLACE FUNCTION util.purge_pulse_history()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM "pulseCount" WHERE "periodEnd" < NOW() - INTERVAL '400 days';
  DELETE FROM "pulseStateChange" WHERE "changedAt" < NOW() - INTERVAL '400 days';
$$;

REVOKE ALL ON FUNCTION util.purge_pulse_history() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'pulse-history-retention'
  ) THEN
    PERFORM cron.unschedule('pulse-history-retention');
  END IF;
  PERFORM cron.schedule(
    'pulse-history-retention',
    '41 4 * * *',
    'SELECT util.purge_pulse_history();'
  );
END;
$$;
