// SPDX-License-Identifier: LicenseRef-Carbon-Commercial
// Carbon Enterprise file, licensed only under the Carbon Commercial License
// (packages/ee/LICENSE). Not AGPL. Running, modifying, or copying it beyond those terms requires a commercial license.

import { posting } from "@carbon/api/postings.server";
import type { Database } from "@carbon/database";
import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import { endSensorMachineTime } from "@carbon/database/machine-time";
import { getLogger } from "@carbon/logger";
import { datetime } from "@carbon/utils";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sql } from "kysely";
import { EntitlementError, requireEntitlement } from "../entitlements.server";
import { integrations } from "../index";
import { resolveIntegrationSecrets } from "../integrations/secrets";
import { companyHasFeature } from "../plan.server";
import { ensureSenseWebhook } from "../sense/webhook.server";
import { machineTimeRefusal } from "./assignable";
import { type MachineCountLabel, postMachineCounts } from "./counts.server";
import { createOeeProvider, isOeeProviderId } from "./registry";
import type { OeeProvider, OeeProviderId } from "./types";

/**
 * OEE provider server functions. The authoring writes embed
 * `requireEntitlement("INTEGRATIONS")`; `getOeeProvider` is the runtime path
 * and degrades through `companyHasFeature` instead of throwing.
 */

const logger = getLogger("ee", "oee");

type Result<T> = { data: T; error: null } | { data: null; error: string };

const fail = (error: unknown): { data: null; error: string } => {
  if (error instanceof EntitlementError) throw error;
  logger.error("OEE provider call failed", { error });
  return {
    data: null,
    error: error instanceof Error ? error.message : String(error)
  };
};

/**
 * Providers that push state changes through a webhook. Each repairs the
 * company's webhook without taking over another system's, and says whether it
 * changed anything.
 */
const OEE_WEBHOOK_REPAIRS: Partial<
  Record<OeeProviderId, (companyId: string) => Promise<boolean>>
> = {
  sense: (companyId) => ensureSenseWebhook(companyId, { repairOnly: true })
};

/**
 * The sweep's repair: registers the webhook of an install made before its
 * provider had one, and brings back one the provider disabled. A company that
 * is not entitled is skipped; any other failure throws, and the next sweep tries
 * again.
 */
export async function repairOeeWebhook(
  integrationId: string,
  companyId: string
): Promise<boolean> {
  if (!isOeeProviderId(integrationId)) return false;
  const repair = OEE_WEBHOOK_REPAIRS[integrationId];
  if (!repair) return false;
  try {
    return await repair(companyId);
  } catch (error) {
    if (error instanceof EntitlementError) return false;
    throw error;
  }
}

export async function getOeeProvider(
  serviceClient: SupabaseClient<Database>,
  companyId: string,
  integrationId: string
): Promise<Result<{ provider: OeeProvider; minimumStateSeconds: number }>> {
  try {
    const entitled = await companyHasFeature(serviceClient, companyId, {
      feature: "INTEGRATIONS"
    });
    if (!entitled) return { data: null, error: "Not entitled" };

    const integration = await serviceClient
      .from("companyIntegration")
      .select("metadata, secretRef, active")
      .eq("companyId", companyId)
      .eq("id", integrationId)
      .maybeSingle();
    if (integration.error) return fail(integration.error.message);
    if (!integration.data?.active) {
      return { data: null, error: "Integration is not active" };
    }

    const metadata = (await resolveIntegrationSecrets(
      serviceClient,
      companyId,
      integrationId,
      integration.data.metadata,
      integration.data.secretRef
    )) as Record<string, unknown>;

    return {
      data: createOeeProvider(integrationId, metadata, {
        companyId,
        serviceClient
      }),
      error: null
    };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Posts the Machine events that sensor time ended (machine and overhead cost
 * to WIP), as an operator's press posts the events it ends. Call it after the
 * transaction that ended them commits. A failure is logged, never thrown: the
 * operation-finish and job-completion catch-ups post what is still unposted.
 */
export async function postEndedMachineEvents(
  db: Kysely<KyselyDatabase>,
  args: { companyId: string; userId: string; productionEventIds: string[] }
) {
  if (args.productionEventIds.length === 0) return;
  const handles = { db, companyId: args.companyId, userId: args.userId };
  for (const productionEventId of args.productionEventIds) {
    const posted = await posting("post-production-event", handles, {
      productionEventId
    });
    // `success: false` is an event with nothing to post yet (no duration):
    // the catch-ups take it once it has one.
    if (posted.error) {
      logger.error("Failed to post a Machine event", {
        companyId: args.companyId,
        productionEventId,
        error: posted.error
      });
    }
  }
}

export async function upsertWorkCenterDevice(
  client: SupabaseClient<Database>,
  db: Kysely<KyselyDatabase>,
  args: {
    companyId: string;
    userId: string;
    integration: string;
    externalDeviceId: string;
    externalSiteId: string | null;
    siteTimezone: string | null;
    deviceName: string;
    workCenterId: string;
  }
): Promise<Result<{ id: string }>> {
  await requireEntitlement(client, args.companyId, "INTEGRATIONS");
  try {
    // Only an active OEE integration maps devices: a row for any other
    // integration would hold the work center's one device slot, and nothing
    // would ever sync it.
    if (!isOeeProviderId(args.integration)) {
      return {
        data: null,
        error: `${args.integration} is not an OEE provider`
      };
    }
    let endedEventIds: string[] = [];
    const result = await db.transaction().execute(async (trx) => {
      const integration = await trx
        .selectFrom("companyIntegration")
        .select("active")
        .where("id", "=", args.integration)
        .where("companyId", "=", args.companyId)
        .executeTakeFirst();
      if (!integration?.active) {
        return { data: null, error: "Integration is not active" };
      }

      // Kysely skips RLS, and the id comes from the form: the work center
      // must be this company's (the composite FK refuses it too).
      const workCenter = await trx
        .selectFrom("workCenter")
        .select("id")
        .where("id", "=", args.workCenterId)
        .where("companyId", "=", args.companyId)
        .executeTakeFirst();
      if (!workCenter) return { data: null, error: "Work center not found" };

      const current = await trx
        .selectFrom("workCenterDevice")
        .select(["id", "workCenterId"])
        .where("integration", "=", args.integration)
        .where("externalDeviceId", "=", args.externalDeviceId)
        .where("companyId", "=", args.companyId)
        .forUpdate()
        .executeTakeFirst();
      if (current?.workCenterId === args.workCenterId) {
        return { data: { id: current.id }, error: null };
      }

      const taken = await trx
        .selectFrom("workCenterDevice")
        .innerJoin("workCenter", (join) =>
          join
            .onRef("workCenter.id", "=", "workCenterDevice.workCenterId")
            .onRef("workCenter.companyId", "=", "workCenterDevice.companyId")
        )
        .select([
          "workCenterDevice.deviceName",
          "workCenterDevice.integration",
          "workCenter.name as workCenterName"
        ])
        .where("workCenterDevice.workCenterId", "=", args.workCenterId)
        .where("workCenterDevice.companyId", "=", args.companyId)
        .executeTakeFirst();
      if (taken) {
        return {
          data: null,
          error: `${taken.workCenterName} already has ${taken.deviceName} from ${
            integrations.find((entry) => entry.id === taken.integration)
              ?.name ?? taken.integration
          }`
        };
      }

      // A remap starts fresh: a new mapping time and no applied state. The
      // time the device opened on its old work center ends now; no later
      // sync of the old mapping will close it.
      if (current) {
        ({ endedEventIds } = await endSensorMachineTime(trx, {
          workCenterId: current.workCenterId,
          companyId: args.companyId,
          userId: args.userId,
          at: datetime.timestamp()
        }));
        await trx
          .deleteFrom("workCenterDevice")
          .where("id", "=", current.id)
          .where("companyId", "=", args.companyId)
          .execute();
      }

      const inserted = await trx
        .insertInto("workCenterDevice")
        .values({
          companyId: args.companyId,
          workCenterId: args.workCenterId,
          integration: args.integration,
          externalDeviceId: args.externalDeviceId,
          externalSiteId: args.externalSiteId,
          siteTimezone: args.siteTimezone,
          deviceName: args.deviceName,
          createdBy: args.userId
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return { data: { id: inserted.id }, error: null };
    });
    await postEndedMachineEvents(db, {
      companyId: args.companyId,
      userId: args.userId,
      productionEventIds: endedEventIds
    });
    return result;
  } catch (error) {
    return fail(error);
  }
}

/**
 * The counting settings of a device mapping. In count mode Auto the sensor
 * posts Log completed and Log scrap on the operation loaded on the work
 * center; only a provider whose descriptor has `providesCounts` can count.
 * Turning Auto on starts counting now: buckets received before are never
 * posted (`countedThrough`).
 */
export async function updateWorkCenterDeviceCounting(
  client: SupabaseClient<Database>,
  db: Kysely<KyselyDatabase>,
  args: {
    companyId: string;
    userId: string;
    workCenterDeviceId: string;
    countMode: "Off" | "Auto";
    scrapReasonId: string | null;
    labelEveryQuantity: number | null;
  }
): Promise<Result<{ id: string }>> {
  await requireEntitlement(client, args.companyId, "INTEGRATIONS");
  try {
    return await db.transaction().execute(async (trx) => {
      const device = await trx
        .selectFrom("workCenterDevice")
        .select(["id", "integration", "countMode"])
        .where("id", "=", args.workCenterDeviceId)
        .where("companyId", "=", args.companyId)
        .forUpdate()
        .executeTakeFirst();
      if (!device) return { data: null, error: "Device mapping not found" };

      const descriptor = integrations.find(
        (entry) => entry.id === device.integration
      ) as { name: string; providesCounts?: boolean } | undefined;
      if (args.countMode === "Auto" && !descriptor?.providesCounts) {
        return {
          data: null,
          error: `${descriptor?.name ?? device.integration} does not count parts`
        };
      }

      // Kysely skips RLS, and the id comes from the form.
      if (args.scrapReasonId) {
        const reason = await trx
          .selectFrom("scrapReason")
          .select("id")
          .where("id", "=", args.scrapReasonId)
          .where("companyId", "=", args.companyId)
          .executeTakeFirst();
        if (!reason) return { data: null, error: "Scrap reason not found" };
      }

      const startsCounting =
        args.countMode === "Auto" && device.countMode !== "Auto";
      await trx
        .updateTable("workCenterDevice")
        .set({
          countMode: args.countMode,
          scrapReasonId: args.scrapReasonId,
          labelEveryQuantity: args.labelEveryQuantity,
          ...(startsCounting ? { countedThrough: sql`now()` } : {}),
          updatedBy: args.userId,
          updatedAt: datetime.timestamp()
        })
        .where("id", "=", device.id)
        .where("companyId", "=", args.companyId)
        .execute();
      return { data: { id: device.id }, error: null };
    });
  } catch (error) {
    return fail(error);
  }
}

export async function deleteWorkCenterDevice(
  client: SupabaseClient<Database>,
  db: Kysely<KyselyDatabase>,
  args: {
    companyId: string;
    userId: string;
    integration: string;
    externalDeviceId: string;
  }
): Promise<Result<null>> {
  await requireEntitlement(client, args.companyId, "INTEGRATIONS");
  try {
    const endedEventIds = await db.transaction().execute(async (trx) => {
      const device = await trx
        .selectFrom("workCenterDevice")
        .select(["id", "workCenterId"])
        .where("integration", "=", args.integration)
        .where("externalDeviceId", "=", args.externalDeviceId)
        .where("companyId", "=", args.companyId)
        .forUpdate()
        .executeTakeFirst();
      if (!device) return [];

      // Nothing syncs this work center after the delete, so the time its
      // sensor opened ends now instead of staying open forever.
      const ended = await endSensorMachineTime(trx, {
        workCenterId: device.workCenterId,
        companyId: args.companyId,
        userId: args.userId,
        at: datetime.timestamp()
      });
      await trx
        .deleteFrom("workCenterDevice")
        .where("id", "=", device.id)
        .where("companyId", "=", args.companyId)
        .execute();
      return ended.endedEventIds;
    });
    await postEndedMachineEvents(db, {
      companyId: args.companyId,
      userId: args.userId,
      productionEventIds: endedEventIds
    });
    return { data: null, error: null };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Assign unattributed time to an operation: insert a Machine event for its
 * interval and delete the row, then post the event. The event is the record;
 * the row was only a question waiting for an answer.
 */
export async function assignUnattributedMachineTime(
  client: SupabaseClient<Database>,
  db: Kysely<KyselyDatabase>,
  args: {
    companyId: string;
    userId: string;
    unattributedMachineTimeId: string;
    jobOperationId: string;
  }
): Promise<Result<{ productionEventId: string }>> {
  await requireEntitlement(client, args.companyId, "INTEGRATIONS");
  try {
    const result = await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("unattributedMachineTime")
        .select(["workCenterId", "startTime", "endTime"])
        .where("id", "=", args.unattributedMachineTimeId)
        .where("companyId", "=", args.companyId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return { data: null, error: "Machine time not found" };
      if (!row.endTime) {
        return { data: null, error: "The machine is still running" };
      }

      // Checked under row locks, in this transaction: a job closed between
      // the route's check and this insert must still refuse the time.
      const operation = await trx
        .selectFrom("jobOperation")
        .innerJoin("job", (join) =>
          join
            .onRef("job.id", "=", "jobOperation.jobId")
            .onRef("job.companyId", "=", "jobOperation.companyId")
        )
        .select(["jobOperation.status", "job.status as jobStatus"])
        .where("jobOperation.id", "=", args.jobOperationId)
        .where("jobOperation.companyId", "=", args.companyId)
        .forUpdate()
        .executeTakeFirst();
      if (!operation) return { data: null, error: "Operation not found" };
      const refusal = machineTimeRefusal(operation.status, operation.jobStatus);
      if (refusal === "Locked") {
        return {
          data: null,
          error: "Cannot modify a locked job. Reopen it first."
        };
      }
      if (refusal) return { data: null, error: `The operation is ${refusal}` };

      const event = await trx
        .insertInto("productionEvent")
        .values({
          type: "Machine",
          jobOperationId: args.jobOperationId,
          workCenterId: row.workCenterId,
          startTime: row.startTime,
          endTime: row.endTime,
          employeeId: null,
          companyId: args.companyId,
          createdBy: args.userId
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await trx
        .deleteFrom("unattributedMachineTime")
        .where("id", "=", args.unattributedMachineTimeId)
        .where("companyId", "=", args.companyId)
        .execute();

      return { data: { productionEventId: event.id }, error: null };
    });
    if (result.data) {
      await postEndedMachineEvents(db, {
        companyId: args.companyId,
        userId: args.userId,
        productionEventIds: [result.data.productionEventId]
      });
    }
    return result;
  } catch (error) {
    return fail(error);
  }
}

/** Dismiss unattributed time: it was not job time, so the row is deleted. */
export async function dismissUnattributedMachineTime(
  client: SupabaseClient<Database>,
  db: Kysely<KyselyDatabase>,
  args: {
    companyId: string;
    unattributedMachineTimeId: string;
  }
): Promise<Result<null>> {
  await requireEntitlement(client, args.companyId, "INTEGRATIONS");
  try {
    // A running row is still the sync's to close: deleting it would let the
    // next sync open the same time again.
    const deleted = await db
      .deleteFrom("unattributedMachineTime")
      .where("id", "=", args.unattributedMachineTimeId)
      .where("companyId", "=", args.companyId)
      .where("endTime", "is not", null)
      .returning("id")
      .executeTakeFirst();
    if (!deleted) {
      return {
        data: null,
        error: "Machine time not found, or the machine is still running"
      };
    }
    return { data: null, error: null };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Assign unattributed counts to an operation: they become pending postings
 * of that operation (Log completed, and Log scrap when the row has scrap),
 * then post the way the sensor's own counts do. Returns the units whose label
 * to print; the caller prints them.
 */
export async function assignUnattributedMachineCount(
  client: SupabaseClient<Database>,
  db: Kysely<KyselyDatabase>,
  args: {
    companyId: string;
    userId: string;
    unattributedMachineCountId: string;
    jobOperationId: string;
  }
): Promise<Result<{ labels: MachineCountLabel[] }>> {
  await requireEntitlement(client, args.companyId, "INTEGRATIONS");
  try {
    const result = await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("unattributedMachineCount")
        .select([
          "workCenterId",
          "periodStart",
          "periodEnd",
          "quantity",
          "scrapQuantity"
        ])
        .where("id", "=", args.unattributedMachineCountId)
        .where("companyId", "=", args.companyId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return { data: null, error: "Machine count not found" };

      // Checked under row locks, in this transaction, as machine time is.
      const operation = await trx
        .selectFrom("jobOperation")
        .innerJoin("job", (join) =>
          join
            .onRef("job.id", "=", "jobOperation.jobId")
            .onRef("job.companyId", "=", "jobOperation.companyId")
        )
        .select(["jobOperation.status", "job.status as jobStatus"])
        .where("jobOperation.id", "=", args.jobOperationId)
        .where("jobOperation.companyId", "=", args.companyId)
        .forUpdate()
        .executeTakeFirst();
      if (!operation) return { data: null, error: "Operation not found" };
      const refusal = machineTimeRefusal(operation.status, operation.jobStatus);
      if (refusal === "Locked") {
        return {
          data: null,
          error: "Cannot modify a locked job. Reopen it first."
        };
      }
      if (refusal) return { data: null, error: `The operation is ${refusal}` };

      const posting = {
        companyId: args.companyId,
        workCenterId: row.workCenterId,
        jobOperationId: args.jobOperationId,
        reclassify: false,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        createdBy: args.userId
      };
      const postings = [
        ...(Number(row.quantity) > 0
          ? [
              {
                ...posting,
                type: "Production" as const,
                quantity: row.quantity
              }
            ]
          : []),
        ...(Number(row.scrapQuantity) > 0
          ? [
              {
                ...posting,
                type: "Scrap" as const,
                quantity: row.scrapQuantity
              }
            ]
          : [])
      ];
      if (postings.length > 0) {
        await trx.insertInto("machineCountPosting").values(postings).execute();
      }
      await trx
        .deleteFrom("unattributedMachineCount")
        .where("id", "=", args.unattributedMachineCountId)
        .where("companyId", "=", args.companyId)
        .execute();

      const device = await trx
        .selectFrom("workCenterDevice")
        .select(["scrapReasonId", "labelEveryQuantity"])
        .where("workCenterId", "=", row.workCenterId)
        .where("companyId", "=", args.companyId)
        .executeTakeFirst();
      return {
        data: {
          workCenterId: row.workCenterId,
          scrapReasonId: device?.scrapReasonId ?? null,
          labelEveryQuantity:
            device?.labelEveryQuantity == null
              ? null
              : Number(device.labelEveryQuantity)
        },
        error: null
      };
    });
    if (!result.data) return { data: null, error: result.error };

    const { labels } = await postMachineCounts(db, {
      companyId: args.companyId,
      ...result.data
    });
    return { data: { labels }, error: null };
  } catch (error) {
    return fail(error);
  }
}

/** Dismiss unattributed counts: they were not job pieces, so the row is deleted. */
export async function dismissUnattributedMachineCount(
  client: SupabaseClient<Database>,
  db: Kysely<KyselyDatabase>,
  args: { companyId: string; unattributedMachineCountId: string }
): Promise<Result<null>> {
  await requireEntitlement(client, args.companyId, "INTEGRATIONS");
  try {
    const deleted = await db
      .deleteFrom("unattributedMachineCount")
      .where("id", "=", args.unattributedMachineCountId)
      .where("companyId", "=", args.companyId)
      .returning("id")
      .executeTakeFirst();
    if (!deleted) return { data: null, error: "Machine count not found" };
    return { data: null, error: null };
  } catch (error) {
    return fail(error);
  }
}

export {
  batchLabelCount,
  type MachineCountLabel,
  postMachineCounts,
  splitAtTarget
} from "./counts.server";
