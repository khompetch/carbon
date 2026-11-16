-- Pulse: the Log scrap push switch, and the send-each-pulse mode.
--
-- A Pulse device has a Log scrap push switch next to its cycle sensor. The
-- operator presses it once for each bad stroke. A bucket now carries the
-- presses (`scrapPulses`) beside the sensor pulses, and the device's lifetime
-- press counter (`scrapCounter`), so lost presses are found the same way as
-- lost pulses. A bucket can hold presses and no pulses.
--
-- `sendEachPulse` makes a device send every cycle at once instead of every
-- `bucketSeconds`, for machines with a long cycle.

ALTER TABLE "pulseCount"
  ADD COLUMN IF NOT EXISTS "scrapPulses" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "scrapCounter" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "pulseCount" DROP CONSTRAINT IF EXISTS "pulseCount_pulses_check";
ALTER TABLE "pulseCount" ADD CONSTRAINT "pulseCount_pulses_check"
  CHECK ("pulses" >= 0 AND "scrapPulses" >= 0 AND "pulses" + "scrapPulses" > 0);

ALTER TABLE "pulseDevice"
  ADD COLUMN IF NOT EXISTS "lastScrapCounter" BIGINT,
  ADD COLUMN IF NOT EXISTS "sendEachPulse" BOOLEAN NOT NULL DEFAULT FALSE;
