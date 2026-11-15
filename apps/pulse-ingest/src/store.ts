// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import { fromAbsolute } from "@internationalized/date";
import type { InferredState, StateChange } from "./state";

/**
 * Every database read and write of the ingest service. The service is the
 * only writer of the pulse tables, through this direct connection; the API
 * reads them only.
 */

export type DeviceRow = {
  id: string;
  companyId: string;
  deviceKey: string;
  expectedCycleSeconds: number | null;
  idleAfterSeconds: number | null;
  offlineAfterSeconds: number;
  debounceMs: number;
  bucketSeconds: number;
  sendEachPulse: boolean;
  lastSeenAt: number | null;
  lastPulseAt: number | null;
  lastCounter: number | null;
  lastScrapCounter: number | null;
  lastSeq: number | null;
  bootId: string | null;
  currentState: InferredState | null;
  currentStateAt: number | null;
  aliveSince: number | null;
  heartbeatCounter: number | null;
  /** True when a work center maps the device to the `pulse` integration. */
  mapped: boolean;
};

/** Kysely hands `timestamptz` over as a JS `Date`; this is epoch ms. */
function ms(value: Date | string | null): number | null {
  if (value === null) return null;
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function iso(value: number): string {
  return fromAbsolute(value, "UTC").toAbsoluteString();
}

function num(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

const INFERRED_STATES = new Set<string>(["Running", "Idle", "Offline"]);

export async function loadDevices(
  db: Kysely<KyselyDatabase>
): Promise<DeviceRow[]> {
  const rows = await db
    .selectFrom("pulseDevice as d")
    .leftJoin("workCenterDevice as w", (join) =>
      join
        .onRef("w.externalDeviceId", "=", "d.deviceKey")
        .onRef("w.companyId", "=", "d.companyId")
        .on("w.integration", "=", "pulse")
    )
    .select([
      "d.id",
      "d.companyId",
      "d.deviceKey",
      "d.expectedCycleSeconds",
      "d.idleAfterSeconds",
      "d.offlineAfterSeconds",
      "d.debounceMs",
      "d.bucketSeconds",
      "d.sendEachPulse",
      "d.lastSeenAt",
      "d.lastPulseAt",
      "d.lastCounter",
      "d.lastScrapCounter",
      "d.lastSeq",
      "d.bootId",
      "d.currentState",
      "d.currentStateAt",
      "d.aliveSince",
      "d.heartbeatCounter",
      "w.id as workCenterDeviceId"
    ])
    .where("d.active", "=", true)
    .execute();

  return rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    deviceKey: row.deviceKey,
    expectedCycleSeconds: num(row.expectedCycleSeconds),
    idleAfterSeconds: row.idleAfterSeconds,
    offlineAfterSeconds: row.offlineAfterSeconds,
    debounceMs: row.debounceMs,
    bucketSeconds: row.bucketSeconds,
    sendEachPulse: row.sendEachPulse,
    lastSeenAt: ms(row.lastSeenAt),
    lastPulseAt: ms(row.lastPulseAt),
    lastCounter: num(row.lastCounter),
    lastScrapCounter: num(row.lastScrapCounter),
    lastSeq: num(row.lastSeq),
    bootId: row.bootId,
    currentState:
      row.currentState && INFERRED_STATES.has(row.currentState)
        ? (row.currentState as InferredState)
        : null,
    currentStateAt: ms(row.currentStateAt),
    aliveSince: ms(row.aliveSince),
    heartbeatCounter: num(row.heartbeatCounter),
    mapped: row.workCenterDeviceId !== null
  }));
}

export type BucketWrite = {
  bootId: string;
  seq: number;
  periodStart: number;
  periodEnd: number;
  pulses: number;
  counter: number;
  /** Log scrap presses in the bucket, and the lifetime press counter after it. */
  scrapPulses: number;
  scrapCounter: number;
  rebased: boolean;
  receivedAt: number;
  /** Pulses and presses of buckets that never arrived, stored as one estimated row. */
  missing: number;
  missingScrap: number;
};

/**
 * Stores one bucket, and the estimated row for lost buckets before it.
 * Returns false when the bucket was already stored (a repeated delivery).
 */
export async function storeBucket(
  db: Kysely<KyselyDatabase>,
  device: { id: string; companyId: string },
  bucket: BucketWrite
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto("pulseCount")
      .values({
        companyId: device.companyId,
        pulseDeviceId: device.id,
        bootId: bucket.bootId,
        seq: bucket.seq,
        periodStart: iso(bucket.periodStart),
        periodEnd: iso(bucket.periodEnd),
        pulses: bucket.pulses,
        counter: bucket.counter,
        scrapPulses: bucket.scrapPulses,
        scrapCounter: bucket.scrapCounter,
        rebased: bucket.rebased,
        receivedAt: iso(bucket.receivedAt)
      })
      .onConflict((oc) =>
        oc
          .columns([
            "pulseDeviceId",
            "bootId",
            "seq",
            "estimated",
            "companyId"
          ])
          .doNothing()
      )
      .returning("id")
      .executeTakeFirst();
    if (!inserted) return false;

    if (bucket.missing + bucket.missingScrap > 0) {
      // When the lost pulses happened is unknown: they are dated at the start
      // of the bucket that revealed them.
      await trx
        .insertInto("pulseCount")
        .values({
          companyId: device.companyId,
          pulseDeviceId: device.id,
          bootId: bucket.bootId,
          seq: bucket.seq,
          periodStart: iso(bucket.periodStart),
          periodEnd: iso(bucket.periodStart),
          pulses: bucket.missing,
          counter: bucket.counter - bucket.pulses,
          scrapPulses: bucket.missingScrap,
          scrapCounter: bucket.scrapCounter - bucket.scrapPulses,
          estimated: true,
          rebased: bucket.rebased,
          receivedAt: iso(bucket.receivedAt)
        })
        .onConflict((oc) =>
          oc
            .columns([
              "pulseDeviceId",
              "bootId",
              "seq",
              "estimated",
              "companyId"
            ])
            .doNothing()
        )
        .execute();
    }

    await trx
      .updateTable("pulseDevice")
      .set({
        lastCounter: bucket.counter,
        lastScrapCounter: bucket.scrapCounter,
        lastSeq: bucket.seq,
        bootId: bucket.bootId
      })
      .where("id", "=", device.id)
      .where("companyId", "=", device.companyId)
      .execute();
    return true;
  });
}

export type DeviceHealth = {
  lastSeenAt: number | null;
  lastPulseAt: number | null;
  currentState: InferredState | null;
  currentStateAt: number | null;
  aliveSince: number | null;
  heartbeatCounter: number | null;
  rssi?: number | null;
  firmwareVersion?: string | null;
  queueDepth?: number | null;
  bootId?: string | null;
};

/** Stores the inferred state changes and the device's tracking in one go. */
export async function storeTracking(
  db: Kysely<KyselyDatabase>,
  device: { id: string; companyId: string },
  health: DeviceHealth,
  changes: StateChange[]
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    if (changes.length > 0) {
      await trx
        .insertInto("pulseStateChange")
        .values(
          changes.map((change) => ({
            companyId: device.companyId,
            pulseDeviceId: device.id,
            state: change.state,
            changedAt: iso(change.changedAt),
            reason: change.reason
          }))
        )
        .onConflict((oc) =>
          oc
            .columns(["pulseDeviceId", "changedAt", "state", "companyId"])
            .doNothing()
        )
        .execute();
    }

    const at = (value: number | null) => (value === null ? null : iso(value));
    await trx
      .updateTable("pulseDevice")
      .set({
        lastSeenAt: at(health.lastSeenAt),
        lastPulseAt: at(health.lastPulseAt),
        currentState: health.currentState,
        currentStateAt: at(health.currentStateAt),
        aliveSince: at(health.aliveSince),
        heartbeatCounter: health.heartbeatCounter,
        ...(health.rssi !== undefined ? { rssi: health.rssi } : {}),
        ...(health.firmwareVersion !== undefined
          ? { firmwareVersion: health.firmwareVersion }
          : {}),
        ...(health.queueDepth !== undefined
          ? { queueDepth: health.queueDepth }
          : {}),
        ...(health.bootId !== undefined ? { bootId: health.bootId } : {})
      })
      .where("id", "=", device.id)
      .where("companyId", "=", device.companyId)
      .execute();
  });
}

export async function writeIngestHeartbeat(
  db: Kysely<KyselyDatabase>,
  version: string
): Promise<void> {
  const now = iso(Date.now());
  await db
    .insertInto("pulseIngestStatus")
    .values({ id: "ingest", heartbeatAt: now, version })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({ heartbeatAt: now, version })
    )
    .execute();
}
