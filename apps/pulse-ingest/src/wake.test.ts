// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { describe, expect, it } from "vitest";
import { syncEventId, wakesForCounts } from "./wake";

// An instant 30 seconds into a minute.
const NOW = 1_763_283_630_000;
const MINUTE = Math.floor(NOW / 60_000);

describe("syncEventId", () => {
  it("wakes a state change at most once a minute", () => {
    expect(
      syncEventId({ id: "pdv1", sendEachPulse: true }, { kind: "state" }, NOW)
    ).toBe(`pulse:pdv1:${MINUTE}`);
  });

  it("wakes a count once a minute on a device that sends buckets", () => {
    expect(
      syncEventId(
        { id: "pdv1", sendEachPulse: false },
        { kind: "count", boot: "b1", seq: 7 },
        NOW
      )
    ).toBe(`pulse:pdv1:count:${MINUTE}`);
  });

  it("wakes each bucket on a device that sends each pulse", () => {
    expect(
      syncEventId(
        { id: "pdv1", sendEachPulse: true },
        { kind: "count", boot: "b1", seq: 7 },
        NOW
      )
    ).toBe("pulse:pdv1:count:b1:7");
  });
});

describe("wakesForCounts", () => {
  it.each([
    [{ mapped: true, countMode: "Auto" as const }, true],
    [{ mapped: true, countMode: "Off" as const }, false],
    [{ mapped: false, countMode: null }, false]
  ])("is %o → %s", (device, expected) => {
    expect(wakesForCounts(device)).toBe(expected);
  });
});
