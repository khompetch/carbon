// SPDX-License-Identifier: LicenseRef-Carbon-Commercial
// Carbon Enterprise file, licensed only under the Carbon Commercial License
// (packages/ee/LICENSE). Not AGPL. Running, modifying, or copying it beyond those terms requires a commercial license.

import { type Database, fetchAllRecords } from "@carbon/database";
import { datetime } from "@carbon/utils";
import { fromAbsolute } from "@internationalized/date";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type MachineState,
  type OeeDevice,
  type OeeProvider,
  OeeProviderUnavailableError,
  type OeeStateChange
} from "../oee/types";

/**
 * Pulse — Carbon's own machine monitor. A device counts one pulse per machine
 * cycle and sends the counts over MQTT. The ingest service (`apps/pulse-ingest`)
 * stores them in `pulseCount` and the state it infers in `pulseStateChange`.
 * This provider reads those tables, so there is no remote API and no webhook:
 * the ingest service sends `carbon/oee-device-sync` itself, and the sweep is
 * the fallback.
 */

/** The ingest service writes its heartbeat every 30 seconds. */
export const INGEST_HEARTBEAT_MAX_AGE_MS = 120_000;

/** Epoch milliseconds of an ISO instant: only to compare instants. */
function epochMs(instant: string): number {
  return Date.parse(instant);
}

function isoAt(ms: number): string {
  return fromAbsolute(ms, "UTC").toAbsoluteString();
}

/**
 * The Offline change for a device the ingest service no longer reports. The
 * ingest service writes Offline itself when a device goes silent, but not when
 * the ingest service is down: then nothing writes, and without this change the
 * machine would keep its last state (often Running) forever.
 *
 * Returns null while the device is still within `offlineAfterSeconds` of its
 * last message, when its newest state is already Offline, or when it never
 * sent a message. The id is stable, so a repeated sync stores it once.
 */
export function silentDeviceChange(device: {
  id: string;
  lastSeenAt: string | null;
  offlineAfterSeconds: number;
  currentState: MachineState | null;
  currentStateAt: string | null;
  now: string;
}): OeeStateChange | null {
  if (device.lastSeenAt === null) return null;
  if (device.currentState === "Offline") return null;

  const lastSeen = epochMs(device.lastSeenAt);
  if (epochMs(device.now) - lastSeen < device.offlineAfterSeconds * 1000) {
    return null;
  }

  // A change never goes at or before the state it replaces.
  const after =
    device.currentStateAt === null ? -1 : epochMs(device.currentStateAt);
  const changedAt = Math.max(lastSeen, after + 1);
  return {
    externalEventId: `offline:${device.id}:${changedAt}`,
    state: "Offline",
    changedAt: isoAt(changedAt)
  };
}

/** Whether the ingest service's heartbeat is recent enough to trust. */
export function ingestHealth(
  heartbeatAt: string | null,
  now: string
): { valid: boolean; error?: string } {
  if (heartbeatAt === null) {
    return {
      valid: false,
      error: "The Pulse ingest service has never reported. Check that it runs."
    };
  }
  if (epochMs(now) - epochMs(heartbeatAt) > INGEST_HEARTBEAT_MAX_AGE_MS) {
    return {
      valid: false,
      error: `The Pulse ingest service last reported at ${heartbeatAt}. Check that it runs and can reach the broker.`
    };
  }
  return { valid: true };
}

export function createPulseProvider({
  companyId,
  serviceClient
}: {
  companyId: string;
  serviceClient: SupabaseClient<Database>;
}): OeeProvider {
  const unavailable = (what: string, message: string) =>
    new OeeProviderUnavailableError(
      `Pulse: could not read ${what}: ${message}`
    );

  return {
    id: "pulse",

    async validate() {
      const status = await serviceClient
        .from("pulseIngestStatus")
        .select("heartbeatAt")
        .eq("id", "ingest")
        .maybeSingle();
      if (status.error) {
        return { valid: false, error: status.error.message };
      }
      return ingestHealth(
        status.data?.heartbeatAt ?? null,
        datetime.timestamp()
      );
    },

    async listDevices(): Promise<OeeDevice[]> {
      const devices = await serviceClient
        .from("pulseDevice")
        .select("deviceKey, name, locationId, location(name, timezone)")
        .eq("companyId", companyId)
        .eq("active", true)
        .order("name");
      if (devices.error) throw unavailable("devices", devices.error.message);

      return devices.data.map((device) => ({
        externalDeviceId: device.deviceKey,
        name: device.name,
        externalSiteId: device.locationId,
        siteName: device.location?.name ?? null,
        siteTimezone: device.location?.timezone || null,
        manufacturer: null,
        model: null,
        machineType: null,
        calibrated: null
      }));
    },

    async listStateChanges(device, window) {
      const found = await serviceClient
        .from("pulseDevice")
        .select(
          "id, lastSeenAt, offlineAfterSeconds, currentState, currentStateAt"
        )
        .eq("companyId", companyId)
        .eq("deviceKey", device.externalDeviceId)
        .maybeSingle();
      if (found.error) throw unavailable("the device", found.error.message);
      if (!found.data) throw new Error("Pulse device not found");
      const pulseDevice = found.data;

      const changes = await fetchAllRecords(() =>
        serviceClient
          .from("pulseStateChange")
          .select("id, state, changedAt")
          .eq("companyId", companyId)
          .eq("pulseDeviceId", pulseDevice.id)
          .gte("changedAt", window.since)
          .lte("changedAt", window.until)
          .order("changedAt")
          .order("id")
      );
      if (changes.error) {
        throw unavailable("state changes", changes.error.message);
      }

      const result: OeeStateChange[] = changes.data.map((change) => ({
        externalEventId: change.id,
        state: change.state,
        changedAt: change.changedAt
      }));

      const silent = silentDeviceChange({
        ...pulseDevice,
        now: window.until
      });
      const last = result.at(-1);
      if (
        silent &&
        last?.state !== "Offline" &&
        (last === undefined ||
          epochMs(silent.changedAt) > epochMs(last.changedAt))
      ) {
        result.push(silent);
      }
      return result;
    }
  };
}
