// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import { detectGap, type LastBucket } from "./gaps";
import type { BootPayload, CountPayload, StatusPayload } from "./protocol";
import {
  type DeviceTiming,
  type DeviceTracking,
  onHeartbeat,
  onPulses,
  onTick,
  type StateChange
} from "./state";
import {
  type DeviceRow,
  type DeviceHealth,
  storeBucket,
  storeTracking
} from "./store";
import { type MonotonicAnchor, nextAnchor, resolveBucketTimes } from "./time";

/**
 * One device's live state in the ingest service. Every message and tick of a
 * device runs through one queue, so its writes never interleave; devices run
 * independently of each other.
 */
export class DeviceWorker {
  private tracking: DeviceTracking;
  private last: LastBucket | null;
  private anchor: MonotonicAnchor | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private row: DeviceRow,
    private readonly db: Kysely<KyselyDatabase>,
    private readonly onChanged: (device: DeviceRow) => void
  ) {
    this.tracking = {
      state: row.currentState,
      stateAt: row.currentStateAt,
      lastPulseAt: row.lastPulseAt,
      lastSeenAt: row.lastSeenAt,
      aliveSince: row.aliveSince,
      lastCounter: row.lastCounter,
      heartbeatCounter: row.heartbeatCounter
    };
    this.last =
      row.bootId !== null && row.lastSeq !== null && row.lastCounter !== null
        ? {
            boot: row.bootId,
            seq: row.lastSeq,
            counter: row.lastCounter,
            scrapCounter: row.lastScrapCounter
          }
        : null;
  }

  get device(): DeviceRow {
    return this.row;
  }

  /** Takes a newer device row (configuration or mapping changed). */
  refresh(row: DeviceRow) {
    this.row = { ...row };
  }

  private get timing(): DeviceTiming {
    return {
      expectedCycleSeconds: this.row.expectedCycleSeconds,
      idleAfterSeconds: this.row.idleAfterSeconds,
      offlineAfterSeconds: this.row.offlineAfterSeconds
    };
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(work, work);
    return this.queue;
  }

  private health(extra: Partial<DeviceHealth> = {}): DeviceHealth {
    return {
      lastSeenAt: this.tracking.lastSeenAt,
      lastPulseAt: this.tracking.lastPulseAt,
      currentState: this.tracking.state,
      currentStateAt: this.tracking.stateAt,
      aliveSince: this.tracking.aliveSince,
      heartbeatCounter: this.tracking.heartbeatCounter,
      ...extra
    };
  }

  private async save(changes: StateChange[], extra?: Partial<DeviceHealth>) {
    await storeTracking(this.db, this.row, this.health(extra), changes);
    if (changes.length > 0) this.onChanged(this.row);
  }

  count(payload: CountPayload, receivedAt: number): Promise<void> {
    return this.enqueue(async () => {
      const gap = detectGap(this.last, {
        boot: payload.boot,
        seq: payload.seq,
        n: payload.n,
        total: payload.total,
        scrap: payload.scrap,
        scrapTotal: payload.scrapTotal
      });
      if (gap.kind === "stale") return;

      if (payload.tsOk) {
        this.anchor = nextAnchor(this.anchor, {
          boot: payload.boot,
          m: payload.m1,
          at: Math.min(payload.t1, receivedAt)
        });
      }
      const times = resolveBucketTimes({
        boot: payload.boot,
        t0: payload.t0,
        t1: payload.t1,
        m1: payload.m1,
        tsOk: payload.tsOk,
        receivedAt,
        anchor: this.anchor
      });

      const stored = await storeBucket(this.db, this.row, {
        bootId: payload.boot,
        seq: payload.seq,
        periodStart: times.periodStart,
        periodEnd: times.periodEnd,
        pulses: payload.n,
        counter: payload.total,
        scrapPulses: payload.scrap,
        scrapCounter: payload.scrapTotal,
        rebased: times.rebased,
        receivedAt,
        missing: gap.missing,
        missingScrap: gap.missingScrap
      });
      this.last = {
        boot: payload.boot,
        seq: payload.seq,
        counter: payload.total,
        scrapCounter: payload.scrapTotal
      };
      if (!stored) return;

      if (payload.n + gap.missing === 0) {
        // Only Log scrap presses: the machine did not cycle, so the state does
        // not become Running. The message still proves the device is alive.
        this.tracking = onHeartbeat(this.tracking, {
          receivedAt,
          counter: payload.total
        });
        await this.save([]);
        return;
      }

      const step = onPulses(this.tracking, this.timing, {
        periodStart: times.periodStart,
        periodEnd: times.periodEnd,
        counter: payload.total,
        receivedAt
      });
      this.tracking = step.tracking;
      await this.save(step.changes);
    });
  }

  status(payload: StatusPayload, receivedAt: number): Promise<void> {
    return this.enqueue(async () => {
      // A live heartbeat dates the monotonic clock of this boot.
      this.anchor = nextAnchor(this.anchor, {
        boot: payload.boot,
        m: payload.m,
        at: receivedAt
      });
      this.tracking = onHeartbeat(this.tracking, {
        receivedAt,
        counter: payload.total
      });
      await this.save([], {
        rssi: payload.rssi ?? null,
        firmwareVersion: payload.fw ?? null,
        queueDepth: payload.queue
      });
    });
  }

  boot(payload: BootPayload, receivedAt: number): Promise<void> {
    return this.enqueue(async () => {
      this.anchor = null;
      this.tracking = onHeartbeat(this.tracking, {
        receivedAt,
        counter: payload.totalAtBoot
      });
      await this.save([], {
        bootId: payload.boot,
        firmwareVersion: payload.fw ?? null
      });
    });
  }

  tick(now: number): Promise<void> {
    return this.enqueue(async () => {
      const step = onTick(this.tracking, this.timing, now);
      if (step.changes.length === 0 && step.tracking === this.tracking) return;
      this.tracking = step.tracking;
      await this.save(step.changes);
    });
  }
}
