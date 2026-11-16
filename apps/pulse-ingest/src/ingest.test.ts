// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { describe, expect, it } from "vitest";
import { detectGap } from "./gaps";
import {
  countPayloadSchema,
  parsePayload,
  parseTopic,
  statusPayloadSchema,
  subscriptionFor,
  topicFor
} from "./protocol";
import { FUTURE_TOLERANCE_MS, nextAnchor, resolveBucketTimes } from "./time";

const NOW = 1_763_100_000_000;

describe("topics", () => {
  it("parses a device topic", () => {
    expect(parseTopic("carbon/pulse/v1/press-01/count")).toEqual({
      deviceKey: "press-01",
      channel: "count"
    });
    expect(topicFor("press-01", "config")).toBe(
      "carbon/pulse/v1/press-01/config"
    );
    expect(subscriptionFor("status")).toBe("carbon/pulse/v1/+/status");
  });

  it("refuses other topics, unknown channels and unsafe device keys", () => {
    expect(parseTopic("other/pulse/v1/press-01/count")).toBeNull();
    expect(parseTopic("carbon/pulse/v1/press-01/reset")).toBeNull();
    expect(parseTopic("carbon/pulse/v1/press-01/count/extra")).toBeNull();
    expect(parseTopic("carbon/pulse/v1/+/count")).toBeNull();
    expect(parseTopic("carbon/pulse/v1/#/count")).toBeNull();
    expect(parseTopic("carbon/pulse/v1//count")).toBeNull();
  });
});

describe("payloads", () => {
  const count = {
    v: 1,
    boot: "9f3a1c2e",
    seq: 4711,
    t0: NOW - 5000,
    t1: NOW,
    m1: 873_421,
    n: 3,
    total: 918_273,
    tsOk: true
  };

  it("parses a count message from text or bytes", () => {
    // A device without the Log scrap switch sends no scrap fields.
    const parsed = { ...count, scrap: 0, scrapTotal: 0 };
    expect(parsePayload(countPayloadSchema, JSON.stringify(count))).toEqual(
      parsed
    );
    const bytes = new TextEncoder().encode(JSON.stringify(count));
    expect(parsePayload(countPayloadSchema, bytes)).toEqual(parsed);
  });

  it("accepts a bucket with only Log scrap presses, or one instant pulse", () => {
    const scrapOnly = { ...count, n: 0, scrap: 1, scrapTotal: 12 };
    expect(
      parsePayload(countPayloadSchema, JSON.stringify(scrapOnly))
    ).toEqual(scrapOnly);
    const instant = { ...count, t0: NOW, t1: NOW, n: 1 };
    expect(
      parsePayload(countPayloadSchema, JSON.stringify(instant))
    ).toEqual({ ...instant, scrap: 0, scrapTotal: 0 });
  });

  it("returns null for a malformed message", () => {
    expect(parsePayload(countPayloadSchema, "{not json")).toBeNull();
    expect(
      parsePayload(countPayloadSchema, JSON.stringify({ ...count, n: 0 }))
    ).toBeNull();
    expect(
      parsePayload(countPayloadSchema, JSON.stringify({ ...count, v: 2 }))
    ).toBeNull();
    expect(
      parsePayload(countPayloadSchema, JSON.stringify({ ...count, n: 1.5 }))
    ).toBeNull();
  });

  it("defaults the heartbeat queue depth to 0", () => {
    const status = parsePayload(
      statusPayloadSchema,
      JSON.stringify({
        v: 1,
        boot: "9f3a1c2e",
        ts: NOW,
        m: 900_000,
        total: 918_273,
        tsOk: true
      })
    );
    expect(status?.queue).toBe(0);
  });
});

describe("resolveBucketTimes", () => {
  const base = {
    boot: "a",
    t0: NOW - 5000,
    t1: NOW,
    m1: 100_000,
    tsOk: true,
    receivedAt: NOW + 200,
    anchor: null
  };

  it("trusts a synchronized device clock", () => {
    expect(resolveBucketTimes(base)).toEqual({
      periodStart: NOW - 5000,
      periodEnd: NOW,
      rebased: false
    });
  });

  it("trusts an old bucket: the device buffered it", () => {
    const hourAgo = NOW - 3_600_000;
    expect(
      resolveBucketTimes({ ...base, t0: hourAgo - 5000, t1: hourAgo })
    ).toEqual({
      periodStart: hourAgo - 5000,
      periodEnd: hourAgo,
      rebased: false
    });
  });

  it("does not let a bucket end after it arrived", () => {
    // 3 s ahead: drift, inside the tolerance.
    const times = resolveBucketTimes({
      ...base,
      t0: NOW - 2000,
      t1: NOW + 3000,
      receivedAt: NOW
    });
    expect(times).toEqual({
      periodStart: NOW - 5000,
      periodEnd: NOW,
      rebased: false
    });
  });

  it("ignores a device clock that is far in the future", () => {
    const ahead = NOW + FUTURE_TOLERANCE_MS + 1000;
    const times = resolveBucketTimes({
      ...base,
      t0: ahead - 5000,
      t1: ahead,
      receivedAt: NOW
    });
    expect(times).toEqual({
      periodStart: NOW - 5000,
      periodEnd: NOW,
      rebased: true
    });
  });

  it("places an unsynchronized bucket from the monotonic anchor", () => {
    // The device clock reads 1970. The anchor says monotonic 160 000 was NOW,
    // so a bucket that ended at monotonic 100 000 ended 60 s before NOW.
    const times = resolveBucketTimes({
      ...base,
      t0: 95_000,
      t1: 100_000,
      tsOk: false,
      receivedAt: NOW + 500,
      anchor: { boot: "a", m: 160_000, at: NOW }
    });
    expect(times).toEqual({
      periodStart: NOW - 65_000,
      periodEnd: NOW - 60_000,
      rebased: true
    });
  });

  it("uses the arrival time when no anchor of this boot is usable", () => {
    const unsynced = { ...base, t0: 95_000, t1: 100_000, tsOk: false };
    const expected = {
      periodStart: NOW + 200 - 5000,
      periodEnd: NOW + 200,
      rebased: true
    };
    expect(resolveBucketTimes(unsynced)).toEqual(expected);
    // Another boot's monotonic clock means nothing here.
    expect(
      resolveBucketTimes({
        ...unsynced,
        anchor: { boot: "b", m: 160_000, at: NOW }
      })
    ).toEqual(expected);
    // An anchor older than the bucket cannot date it.
    expect(
      resolveBucketTimes({
        ...unsynced,
        anchor: { boot: "a", m: 50_000, at: NOW }
      })
    ).toEqual(expected);
  });
});

describe("nextAnchor", () => {
  it("keeps the newest anchor of a boot and replaces it on a new boot", () => {
    const first = { boot: "a", m: 1000, at: NOW };
    expect(nextAnchor(null, first)).toEqual(first);
    expect(nextAnchor(first, { boot: "a", m: 500, at: NOW + 1 })).toEqual(
      first
    );
    const newer = { boot: "a", m: 2000, at: NOW + 1000 };
    expect(nextAnchor(first, newer)).toEqual(newer);
    const rebooted = { boot: "b", m: 10, at: NOW + 2000 };
    expect(nextAnchor(newer, rebooted)).toEqual(rebooted);
  });
});

describe("detectGap", () => {
  const last = { boot: "a", seq: 10, counter: 100, scrapCounter: 4 };
  const bucket = (overrides: Partial<Parameters<typeof detectGap>[1]>) => ({
    boot: "a",
    seq: 11,
    n: 4,
    total: 104,
    scrap: 0,
    scrapTotal: 4,
    ...overrides
  });

  it("stores the first bucket of a device", () => {
    expect(
      detectGap(null, bucket({ seq: 1, n: 3, total: 3, scrapTotal: 0 }))
    ).toEqual({ kind: "store", missing: 0, missingScrap: 0 });
  });

  it("stores the next bucket with nothing missing", () => {
    expect(detectGap(last, bucket({}))).toEqual({
      kind: "store",
      missing: 0,
      missingScrap: 0
    });
  });

  it("drops a bucket it already has", () => {
    expect(detectGap(last, bucket({ seq: 10, total: 100 }))).toEqual({
      kind: "stale"
    });
    expect(detectGap(last, bucket({ seq: 7, n: 2, total: 90 }))).toEqual({
      kind: "stale"
    });
  });

  it("counts the pulses of buckets that never arrived", () => {
    // seq 11 and 12 were lost: 9 pulses the counter saw and no bucket carried.
    expect(detectGap(last, bucket({ seq: 13, total: 113 }))).toEqual({
      kind: "store",
      missing: 9,
      missingScrap: 0
    });
  });

  it("counts the Log scrap presses of buckets that never arrived", () => {
    // 2 presses in this bucket; the counter moved by 5, so 3 were lost.
    expect(
      detectGap(last, bucket({ seq: 13, n: 0, total: 100, scrap: 2, scrapTotal: 9 }))
    ).toEqual({ kind: "store", missing: 0, missingScrap: 3 });
  });

  it("counts pulses lost across a restart", () => {
    // The device restarted: seq starts again, the lifetime counter does not.
    expect(detectGap(last, bucket({ boot: "b", seq: 1, n: 2, total: 107 }))).toEqual({
      kind: "store",
      missing: 5,
      missingScrap: 0
    });
  });

  it("infers nothing when the device lost its lifetime counters", () => {
    expect(
      detectGap(last, bucket({ boot: "b", seq: 1, n: 2, total: 2, scrapTotal: 0 }))
    ).toEqual({ kind: "store", missing: 0, missingScrap: 0 });
  });

  it("infers no lost presses when the stored bucket had no press counter", () => {
    expect(
      detectGap({ ...last, scrapCounter: null }, bucket({ scrap: 1, scrapTotal: 50 }))
    ).toEqual({ kind: "store", missing: 0, missingScrap: 0 });
  });
});
