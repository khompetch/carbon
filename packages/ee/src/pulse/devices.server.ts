// SPDX-License-Identifier: LicenseRef-Carbon-Commercial
// Carbon Enterprise file, licensed only under the Carbon Commercial License
// (packages/ee/LICENSE). Not AGPL. Running, modifying, or copying it beyond those terms requires a commercial license.

import type { Database } from "@carbon/database";
import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import { datetime } from "@carbon/utils";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireEntitlement } from "../entitlements.server";

/**
 * Registration of Pulse devices. The API reads `pulseDevice` only (RLS has no
 * write policy), so the Pulse Devices tab writes through these building
 * blocks on a direct connection. The ingest service reads the device list
 * again every `PULSE_RELOAD_SECONDS`, so a change reaches it within a minute.
 */

type Result<T> = { data: T; error: null } | { data: null; error: string };

export type PulseDeviceSettings = {
  name: string;
  locationId: string | null;
  piecesPerPulse: number;
  expectedCycleSeconds: number | null;
  idleAfterSeconds: number | null;
  offlineAfterSeconds: number;
  debounceMs: number;
  bucketSeconds: number;
  /** Send each pulse at once instead of every `bucketSeconds`. */
  sendEachPulse: boolean;
  active: boolean;
};

/** The broker's topic segment and MQTT username: see `pulseDevice_deviceKey_check`. */
export const PULSE_DEVICE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Register a new device, or change the settings of a registered one. The
 * device key never changes after the device is registered: it is the
 * `externalDeviceId` a work center mapping holds and the device's MQTT
 * identity. When the device is mapped, the mapping's stored name and time
 * zone follow the device.
 */
export async function savePulseDevice(
  client: SupabaseClient<Database>,
  db: Kysely<KyselyDatabase>,
  args: {
    companyId: string;
    userId: string;
    /** Absent for a new device. */
    id?: string;
    /** Read for a new device only. */
    deviceKey: string;
    settings: PulseDeviceSettings;
  }
): Promise<Result<{ id: string; deviceKey: string }>> {
  await requireEntitlement(client, args.companyId, "INTEGRATIONS");
  const { settings } = args;

  return db.transaction().execute(async (trx) => {
    // Kysely skips RLS, and the id comes from the form: the location must be
    // this company's (the composite FK refuses it too).
    let timezone: string | null = null;
    if (settings.locationId) {
      const location = await trx
        .selectFrom("location")
        .select("timezone")
        .where("id", "=", settings.locationId)
        .where("companyId", "=", args.companyId)
        .executeTakeFirst();
      if (!location) return { data: null, error: "Location not found" };
      timezone = location.timezone || null;
    }

    if (args.id) {
      const updated = await trx
        .updateTable("pulseDevice")
        .set({
          ...settings,
          updatedBy: args.userId,
          updatedAt: datetime.timestamp()
        })
        .where("id", "=", args.id)
        .where("companyId", "=", args.companyId)
        .returning(["id", "deviceKey"])
        .executeTakeFirst();
      if (!updated) return { data: null, error: "Device not found" };

      await trx
        .updateTable("workCenterDevice")
        .set({
          deviceName: settings.name,
          externalSiteId: settings.locationId,
          siteTimezone: timezone
        })
        .where("companyId", "=", args.companyId)
        .where("integration", "=", "pulse")
        .where("externalDeviceId", "=", updated.deviceKey)
        .execute();
      return { data: updated, error: null };
    }

    const deviceKey = args.deviceKey.trim();
    if (!PULSE_DEVICE_KEY_PATTERN.test(deviceKey)) {
      return {
        data: null,
        error:
          "The device key must start with a letter or a digit and use only letters, digits, - and _ (64 characters at most)"
      };
    }
    // The key is unique on the whole server, since the broker's topics are.
    // Another company's device is not named, only refused.
    const taken = await trx
      .selectFrom("pulseDevice")
      .select("companyId")
      .where("deviceKey", "=", deviceKey)
      .executeTakeFirst();
    if (taken) {
      return {
        data: null,
        error: `The device key ${deviceKey} is already registered`
      };
    }

    const inserted = await trx
      .insertInto("pulseDevice")
      .values({
        ...settings,
        companyId: args.companyId,
        deviceKey,
        createdBy: args.userId
      })
      .returning(["id", "deviceKey"])
      .executeTakeFirstOrThrow();
    return { data: inserted, error: null };
  });
}

/**
 * Delete a device and its counts and state changes. A mapped device is
 * refused: unmap it on the Devices tab first, which closes its machine time.
 */
export async function deletePulseDevice(
  client: SupabaseClient<Database>,
  db: Kysely<KyselyDatabase>,
  args: { companyId: string; id: string }
): Promise<Result<{ id: string }>> {
  await requireEntitlement(client, args.companyId, "INTEGRATIONS");

  return db.transaction().execute(async (trx) => {
    const device = await trx
      .selectFrom("pulseDevice")
      .select(["id", "deviceKey", "name"])
      .where("id", "=", args.id)
      .where("companyId", "=", args.companyId)
      .forUpdate()
      .executeTakeFirst();
    if (!device) return { data: null, error: "Device not found" };

    const mapping = await trx
      .selectFrom("workCenterDevice")
      .innerJoin("workCenter", (join) =>
        join
          .onRef("workCenter.id", "=", "workCenterDevice.workCenterId")
          .onRef("workCenter.companyId", "=", "workCenterDevice.companyId")
      )
      .select("workCenter.name as workCenterName")
      .where("workCenterDevice.companyId", "=", args.companyId)
      .where("workCenterDevice.integration", "=", "pulse")
      .where("workCenterDevice.externalDeviceId", "=", device.deviceKey)
      .executeTakeFirst();
    if (mapping) {
      return {
        data: null,
        error: `${device.name} is mapped to ${mapping.workCenterName}. Unmap it on the Devices tab first.`
      };
    }

    await trx
      .deleteFrom("pulseDevice")
      .where("id", "=", device.id)
      .where("companyId", "=", args.companyId)
      .execute();
    return { data: { id: device.id }, error: null };
  });
}
