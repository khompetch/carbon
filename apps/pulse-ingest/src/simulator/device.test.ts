// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { describe, expect, it } from "vitest";
import { detectGap } from "../gaps";
import { countPayloadSchema, parsePayload } from "../protocol";
import { type SimMessage, SimDevice, type SimSettings } from "./device";

const T = 1_763_100_000_000;

function device(settings: Partial<SimSettings> = {}) {
  const sim = new SimDevice(
    "press-01",
    { bucketSeconds: 5, heartbeatSeconds: 30, sendEachPulse: false, ...settings },
    () => 0.5 // no jitter
  );
  sim.powerOn(T);
  return sim;
}

const counts = (messages: SimMessage[]) =>
  messages.flatMap((m) => (m.channel === "count" ? [m.payload] : []));

describe("SimDevice", () => {
  it("sends a boot message and a heartbeat when powered on", () => {
    const sim = new SimDevice("press-01", {
      bucketSeconds: 5,
      heartbeatSeconds: 30,
      sendEachPulse: false
    });
    expect(sim.powerOn(T).map((m) => m.channel)).toEqual(["boot", "status"]);
  });

  it("sends the pulses of a bucket when the bucket ends, with valid payloads", () => {
    const sim = device();
    sim.pulse(T + 1000, 2);
    sim.pulse(T + 2000);
    expect(sim.tick(T + 5999)).toEqual([]);
    const [bucket] = counts(sim.tick(T + 6000));
    expect(bucket).toMatchObject({ seq: 1, n: 3, total: 3, t0: T + 1000, t1: T + 6000 });
    expect(parsePayload(countPayloadSchema, JSON.stringify(bucket))).toEqual(bucket);
  });

  it("sends each pulse within the gap in send-each-pulse mode", () => {
    const sim = device({ sendEachPulse: true });
    sim.pulse(T + 1000);
    const [bucket] = counts(sim.tick(T + 1200));
    expect(bucket).toMatchObject({ seq: 1, n: 1, t0: T + 1000, t1: T + 1000 });
  });

  it("merges pulses closer than the gap in send-each-pulse mode", () => {
    const sim = device({ sendEachPulse: true });
    sim.pulse(T + 1000);
    sim.pulse(T + 1100);
    const [bucket] = counts(sim.tick(T + 1300));
    expect(bucket).toMatchObject({ n: 2, t0: T + 1000, t1: T + 1100 });
  });

  it("sends a Log scrap press at once, with the pulses counted so far", () => {
    const sim = device();
    sim.pulse(T + 1000);
    const [bucket] = counts(sim.scrap(T + 1500));
    expect(bucket).toMatchObject({ n: 1, scrap: 1, total: 1, scrapTotal: 1 });
  });

  it("keeps counting while the network is down and replays in order", () => {
    const sim = device();
    sim.dropNetwork();
    sim.pulse(T + 1000);
    sim.tick(T + 6000);
    sim.pulse(T + 7000);
    sim.tick(T + 12_000);
    expect(sim.queue).toBe(2);
    const replay = counts(sim.restoreNetwork(T + 20_000));
    expect(replay.map((b) => [b.seq, b.total])).toEqual([
      [1, 1],
      [2, 2]
    ]);
    expect(sim.queue).toBe(0);
  });

  it("loses the bucket it was told to drop, which the counter reveals", () => {
    const sim = device();
    sim.pulse(T + 1000, 4);
    const first = counts(sim.tick(T + 6000))[0]!;
    sim.dropNextBucket();
    sim.pulse(T + 7000, 3);
    expect(counts(sim.tick(T + 12_000))).toEqual([]);
    sim.pulse(T + 13_000, 2);
    const third = counts(sim.tick(T + 18_000))[0]!;
    expect(third.seq).toBe(3);
    const last = { boot: first.boot, seq: first.seq, counter: first.total, scrapCounter: 0 };
    expect(detectGap(last, third)).toEqual({ kind: "store", missing: 3, missingScrap: 0 });
  });

  it("starts a new boot on reboot, keeping the lifetime counter", () => {
    const sim = device();
    sim.pulse(T + 1000, 5);
    const before = sim.boot;
    const messages = sim.reboot(T + 2000);
    expect(counts(messages)[0]).toMatchObject({ boot: before, n: 5 });
    expect(messages.find((m) => m.channel === "boot")?.payload).toMatchObject({
      totalAtBoot: 5
    });
    expect(sim.boot).not.toBe(before);
    expect(sim.seq).toBe(0);
    expect(sim.total).toBe(5);
  });

  it("runs machine cycles at the cycle time", () => {
    const sim = device();
    sim.setRun(T, { cycleSeconds: 2, jitterPercent: 10 });
    sim.tick(T + 4500);
    const [bucket] = counts(sim.tick(T + 7001));
    // Cycles at +2 s and +4 s open the bucket at +2 s; +6 s falls in it too.
    expect(bucket).toMatchObject({ n: 3, t0: T + 2000 });
  });

  it("dates buckets a year off with tsOk false while the clock is not synchronized", () => {
    const sim = device();
    sim.setClockSynced(false);
    sim.pulse(T + 1000);
    const [bucket] = counts(sim.tick(T + 6000));
    expect(bucket!.tsOk).toBe(false);
    expect(bucket!.t1).toBeLessThan(T - 300 * 24 * 3600 * 1000);
  });
});
