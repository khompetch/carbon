// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import {
  type BootPayload,
  type ConfigPayload,
  type CountPayload,
  SEND_EACH_PULSE_MIN_GAP_MS,
  type StatusPayload
} from "../protocol";

/**
 * A simulated Pulse device: the firmware's counting and sending rules,
 * without a network. Every method takes the time as epoch milliseconds and
 * returns the messages the device would publish now. The server sends them
 * over MQTT; tests read them.
 *
 * What a real device keeps across a power cut is kept here too: the lifetime
 * counters (FRAM) and the buckets not yet sent (flash). The bucket being
 * counted is in RAM, so a power cut loses it; its pulses are still in the
 * lifetime counter, and the ingest service recovers them as an estimated row.
 */

export type SimMessage =
  | { channel: "count"; payload: CountPayload }
  | { channel: "status"; payload: StatusPayload }
  | { channel: "boot"; payload: BootPayload };

export type SimSettings = Pick<
  ConfigPayload,
  "bucketSeconds" | "heartbeatSeconds" | "sendEachPulse"
>;

export type SimRun = { cycleSeconds: number; jitterPercent: number };

type OpenBucket = {
  t0: number;
  lastAt: number;
  n: number;
  scrap: number;
  /** When the bucket is due to close. */
  closeAt: number;
};

export const FIRMWARE_VERSION = "sim-1.0";

/** A wall clock this far off is clearly wrong; the ingest service must not trust it. */
export const UNSYNCED_CLOCK_OFFSET_MS = -365 * 24 * 3600 * 1000;

export class SimDevice {
  powered = false;
  networkUp = true;
  boot = "";
  seq = 0;
  total = 0;
  scrapTotal = 0;
  tsOk = true;
  run: SimRun | null = null;
  settings: SimSettings;
  /** Buckets closed while the network was down, oldest first. */
  buffer: CountPayload[] = [];
  lastSent: CountPayload | null = null;
  /** Buckets the device closed but never sent (`dropNextBucket`). */
  lost = 0;

  private bootedAt = 0;
  private open: OpenBucket | null = null;
  private dropNext = false;
  private lastStatusAt = 0;
  private nextCycleAt: number | null = null;
  private bootCount = 0;

  constructor(
    readonly deviceKey: string,
    settings: SimSettings,
    private readonly random: () => number = Math.random
  ) {
    this.settings = { ...settings };
  }

  /** The device's wall clock: wrong by a year until it synchronizes. */
  private wall(now: number) {
    return this.tsOk ? now : now + UNSYNCED_CLOCK_OFFSET_MS;
  }

  /** The monotonic clock: milliseconds since this boot. */
  private mono(now: number) {
    return now - this.bootedAt;
  }

  get queue() {
    return this.buffer.length;
  }

  get pending(): { n: number; scrap: number } {
    return { n: this.open?.n ?? 0, scrap: this.open?.scrap ?? 0 };
  }

  powerOn(now: number): SimMessage[] {
    if (this.powered) return [];
    this.powered = true;
    return this.startBoot(now);
  }

  /** A power cut: the bucket being counted is lost, the counters are not. */
  unplug() {
    this.powered = false;
    this.open = null;
    this.nextCycleAt = null;
  }

  reboot(now: number): SimMessage[] {
    if (!this.powered) return [];
    // A controlled restart writes the open bucket out first.
    return [...this.closeBucket(now), ...this.startBoot(now)];
  }

  /** New hardware or erased storage: the lifetime counters start at 0. */
  factoryReset(now: number): SimMessage[] {
    this.open = null;
    this.buffer = [];
    this.total = 0;
    this.scrapTotal = 0;
    return this.powered ? this.startBoot(now) : [];
  }

  private startBoot(now: number): SimMessage[] {
    this.bootCount += 1;
    this.boot = `${this.deviceKey}-${now.toString(36)}-${this.bootCount}`;
    this.seq = 0;
    this.bootedAt = now;
    this.lastStatusAt = now;
    this.nextCycleAt = this.run ? now + this.cycleMs() : null;
    if (!this.networkUp) return [];
    return [
      {
        channel: "boot",
        payload: {
          v: 1,
          boot: this.boot,
          fw: FIRMWARE_VERSION,
          reset: "power",
          totalAtBoot: this.total
        }
      },
      this.status(now),
      ...this.flush()
    ];
  }

  setRun(now: number, run: SimRun | null) {
    this.run = run;
    this.nextCycleAt = run && this.powered ? now + this.cycleMs() : null;
  }

  private cycleMs() {
    const run = this.run!;
    const spread = (this.random() * 2 - 1) * (run.jitterPercent / 100);
    return Math.max(50, run.cycleSeconds * 1000 * (1 + spread));
  }

  /** `count` sensor pulses at `at`, as the interrupt counts them. */
  pulse(at: number, count = 1): SimMessage[] {
    if (!this.powered || count <= 0) return [];
    this.total += count;
    if (this.settings.sendEachPulse) {
      // Pulses closer than the gap share one bucket; a lone pulse is sent at once.
      if (this.open && at - this.open.lastAt >= SEND_EACH_PULSE_MIN_GAP_MS) {
        const sent = this.closeBucket(at);
        this.openBucket(at).n += count;
        return [...sent, ...this.closeIfDue(at)];
      }
      const bucket = this.open ?? this.openBucket(at);
      bucket.n += count;
      bucket.lastAt = at;
      bucket.closeAt = at + SEND_EACH_PULSE_MIN_GAP_MS;
      return [];
    }
    const bucket = this.open ?? this.openBucket(at);
    bucket.n += count;
    bucket.lastAt = at;
    return [];
  }

  /** The Log scrap push switch: one press, sent at once in both modes. */
  scrap(at: number): SimMessage[] {
    if (!this.powered) return [];
    this.scrapTotal += 1;
    const bucket = this.open ?? this.openBucket(at);
    bucket.scrap += 1;
    bucket.lastAt = at;
    return this.closeBucket(at);
  }

  private openBucket(at: number): OpenBucket {
    this.open = {
      t0: at,
      lastAt: at,
      n: 0,
      scrap: 0,
      closeAt: at + this.settings.bucketSeconds * 1000
    };
    return this.open;
  }

  private closeIfDue(now: number): SimMessage[] {
    if (this.settings.sendEachPulse && this.open) {
      this.open.closeAt = Math.min(
        this.open.closeAt,
        this.open.lastAt + SEND_EACH_PULSE_MIN_GAP_MS
      );
    }
    return this.open && now >= this.open.closeAt ? this.closeBucket(now) : [];
  }

  private closeBucket(now: number): SimMessage[] {
    const bucket = this.open;
    this.open = null;
    if (!bucket || bucket.n + bucket.scrap === 0) return [];
    this.seq += 1;
    // One instant pulse has no duration: t0 = t1.
    const end = this.settings.sendEachPulse ? bucket.lastAt : now;
    const payload: CountPayload = {
      v: 1,
      boot: this.boot,
      seq: this.seq,
      t0: this.wall(bucket.t0),
      t1: this.wall(Math.max(bucket.t0, end)),
      m1: this.mono(Math.max(bucket.t0, end)),
      n: bucket.n,
      total: this.total,
      scrap: bucket.scrap,
      scrapTotal: this.scrapTotal,
      tsOk: this.tsOk
    };
    if (this.dropNext) {
      this.dropNext = false;
      this.lost += 1;
      return [];
    }
    if (!this.networkUp) {
      this.buffer.push(payload);
      return [];
    }
    this.lastSent = payload;
    return [{ channel: "count", payload }];
  }

  /** The time passes: machine cycles, due buckets, the heartbeat. */
  tick(now: number): SimMessage[] {
    if (!this.powered) return [];
    const messages: SimMessage[] = [];
    while (this.run && this.nextCycleAt !== null && this.nextCycleAt <= now) {
      const at = this.nextCycleAt;
      messages.push(...this.closeIfDue(at), ...this.pulse(at));
      this.nextCycleAt = at + this.cycleMs();
    }
    messages.push(...this.closeIfDue(now));
    if (
      this.networkUp &&
      now - this.lastStatusAt >= this.settings.heartbeatSeconds * 1000
    ) {
      messages.push(this.status(now));
    }
    return messages;
  }

  private status(now: number): SimMessage {
    this.lastStatusAt = now;
    return {
      channel: "status",
      payload: {
        v: 1,
        boot: this.boot,
        ts: this.wall(now),
        m: this.mono(now),
        total: this.total,
        rssi: -55,
        heap: 180_000,
        fw: FIRMWARE_VERSION,
        queue: this.buffer.length,
        tsOk: this.tsOk
      }
    };
  }

  dropNetwork() {
    this.networkUp = false;
  }

  /** The network is back: the buffered buckets go out in order. */
  restoreNetwork(now: number): SimMessage[] {
    this.networkUp = true;
    if (!this.powered) return [];
    return [...this.flush(), this.status(now)];
  }

  private flush(): SimMessage[] {
    const messages = this.buffer.map(
      (payload): SimMessage => ({ channel: "count", payload })
    );
    if (this.buffer.length > 0) this.lastSent = this.buffer.at(-1)!;
    this.buffer = [];
    return messages;
  }

  /** The next bucket is counted but never sent, as if the message were lost. */
  dropNextBucket() {
    this.dropNext = true;
  }

  /** The last bucket again, as a repeated QoS 1 delivery. */
  duplicateLast(): SimMessage[] {
    return this.powered && this.networkUp && this.lastSent
      ? [{ channel: "count", payload: this.lastSent }]
      : [];
  }

  setClockSynced(tsOk: boolean) {
    this.tsOk = tsOk;
  }

  applySettings(settings: Partial<SimSettings>) {
    this.settings = { ...this.settings, ...settings };
  }
}
