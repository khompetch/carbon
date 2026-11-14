// SPDX-License-Identifier: LicenseRef-Carbon-Commercial
// Carbon Enterprise file, licensed only under the Carbon Commercial License
// (packages/ee/LICENSE). Not AGPL. Running, modifying, or copying it beyond those terms requires a commercial license.

import { getCarbonServiceRole } from "@carbon/auth/client.server";
import type { KyselyDatabase } from "@carbon/database/client";
import { getPostgresClient, getProcessPool } from "@carbon/database/client";
import {
  endSensorMachineTime,
  lockWorkCenterDevice
} from "@carbon/database/machine-time";
import { datetime } from "@carbon/utils";
import { PostgresDriver } from "kysely";
import { postEndedMachineEvents } from "../oee/service.server";
import type { IntegrationHealthcheckResult } from "../types";
import { createPulseProvider } from "./provider";

/** Pulse has no remote account: healthy while the ingest service reports. */
export async function pulseHealthcheck(
  companyId: string
): Promise<IntegrationHealthcheckResult> {
  try {
    const provider = createPulseProvider({
      companyId,
      serviceClient: getCarbonServiceRole()
    });
    const { valid, error } = await provider.validate();
    return valid ? { healthy: true } : { healthy: false, reason: error };
  } catch (error) {
    return {
      healthy: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Uninstalling Pulse stops its sync, so nothing would ever close the time its
 * devices opened: each device's open sensor Machine event and running
 * unattributed time end now, under the device lock, and the ended events
 * post. The mappings and the devices stay, so reinstalling resumes each device
 * from where it left off. Same as `senseOnUninstall`.
 */
export async function pulseOnUninstall(companyId: string) {
  const db = getPostgresClient<KyselyDatabase>(
    getProcessPool(),
    PostgresDriver
  );
  const devices = await db
    .selectFrom("workCenterDevice")
    .select("workCenterId")
    .where("companyId", "=", companyId)
    .where("integration", "=", "pulse")
    .execute();
  const at = datetime.timestamp();
  for (const { workCenterId } of devices) {
    const { endedEventIds } = await db.transaction().execute(async (trx) => {
      await lockWorkCenterDevice(trx, { workCenterId, companyId });
      return endSensorMachineTime(trx, {
        workCenterId,
        companyId,
        userId: "system",
        at
      });
    });
    await postEndedMachineEvents(db, {
      companyId,
      userId: "system",
      productionEventIds: endedEventIds
    });
  }
}
