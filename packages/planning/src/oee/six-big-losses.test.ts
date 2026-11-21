// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { describe, expect, it } from "vitest";
import type { OeeWorkCenterInput } from "./oee.ts";
import {
  computeSixBigLosses,
  operationSpeedLossMs,
  type SixBigLossesInput,
  type SixBigLossKey
} from "./six-big-losses.ts";

const MIN = 60_000;

function base(overrides: Partial<SixBigLossesInput> = {}): SixBigLossesInput {
  return {
    now: 120 * MIN,
    setupEvents: [],
    stops: [],
    rejects: [],
    speedLossMs: 0,
    ...overrides
  };
}

function valuesOf(input: SixBigLossesInput) {
  return Object.fromEntries(
    computeSixBigLosses(input).map((loss) => [loss.key, loss.value])
  ) as Record<SixBigLossKey, number | null>;
}

describe("computeSixBigLosses", () => {
  it("is zero everywhere for an operation with nothing logged", () => {
    expect(valuesOf(base())).toEqual({
      breakdowns: 0,
      setupAdjustments: 0,
      smallStops: 0,
      reducedSpeed: 0,
      startupRejects: 0,
      productionRejects: 0
    });
  });

  it("puts each stop under its reason's loss", () => {
    const values = valuesOf(
      base({
        stops: [
          { startTime: 0, endTime: 18 * MIN, oeeLoss: "Breakdown" },
          {
            startTime: 30 * MIN,
            endTime: 35 * MIN,
            oeeLoss: "Setup & Adjustment"
          },
          { startTime: 40 * MIN, endTime: 46 * MIN, oeeLoss: "Small Stop" }
        ]
      })
    );
    expect(values.breakdowns).toBe(18);
    expect(values.setupAdjustments).toBe(5);
    expect(values.smallStops).toBe(6);
  });

  it("adds Setup event time to adjustment stops, counting overlap once", () => {
    // Setup 0–30, adjustment 20–40: covered 0–40 = 40 minutes
    const values = valuesOf(
      base({
        setupEvents: [{ startTime: 0, endTime: 30 * MIN }],
        stops: [
          {
            startTime: 20 * MIN,
            endTime: 40 * MIN,
            oeeLoss: "Setup & Adjustment"
          }
        ]
      })
    );
    expect(values.setupAdjustments).toBe(40);
  });

  it("counts two operators' overlapping Setup events once", () => {
    const values = valuesOf(
      base({
        setupEvents: [
          { startTime: 0, endTime: 30 * MIN },
          { startTime: 10 * MIN, endTime: 25 * MIN }
        ]
      })
    );
    expect(values.setupAdjustments).toBe(30);
  });

  it("runs an open stop until now", () => {
    const values = valuesOf(
      base({
        now: 100 * MIN,
        stops: [{ startTime: 90 * MIN, endTime: null, oeeLoss: "Breakdown" }]
      })
    );
    expect(values.breakdowns).toBe(10);
  });

  it("splits rejects into startup and production by the Setup flag", () => {
    const values = valuesOf(
      base({
        rejects: [
          { quantity: 3, duringSetup: true },
          { quantity: 1, duringSetup: true },
          { quantity: 4, duringSetup: false }
        ]
      })
    );
    expect(values.startupRejects).toBe(4);
    expect(values.productionRejects).toBe(4);
  });

  it("reports reduced speed as unknown without a standard and never below zero", () => {
    expect(valuesOf(base({ speedLossMs: null })).reducedSpeed).toBeNull();
    expect(valuesOf(base({ speedLossMs: -5 * MIN })).reducedSpeed).toBe(0);
    expect(valuesOf(base({ speedLossMs: 22 * MIN })).reducedSpeed).toBe(22);
  });

  it("lists the losses in factor order with their units", () => {
    expect(
      computeSixBigLosses(base()).map(({ key, factor, unit }) => [
        key,
        factor,
        unit
      ])
    ).toEqual([
      ["breakdowns", "availability", "minutes"],
      ["setupAdjustments", "availability", "minutes"],
      ["smallStops", "performance", "minutes"],
      ["reducedSpeed", "performance", "minutes"],
      ["startupRejects", "quality", "pieces"],
      ["productionRejects", "quality", "pieces"]
    ]);
  });
});

describe("operationSpeedLossMs", () => {
  function wc(overrides: Partial<OeeWorkCenterInput> = {}): OeeWorkCenterInput {
    return {
      period: { start: 0, end: 240 * MIN },
      plannedWindows: [{ start: 0, end: 240 * MIN }],
      runIntervals: [{ start: 0, end: 120 * MIN }],
      owners: [
        { start: 0, end: 60 * MIN, jobOperationId: "A" },
        { start: 60 * MIN, end: 120 * MIN, jobOperationId: "B" }
      ],
      // A: 30 s a piece, B: 60 s a piece
      idealByOperation: new Map([
        ["A", 30],
        ["B", 60]
      ]),
      deviceIdealSeconds: null,
      counts: [
        { at: 30 * MIN, jobOperationId: "A", total: 80, bad: 0 },
        { at: 90 * MIN, jobOperationId: "B", total: 50, bad: 0 }
      ],
      ...overrides
    };
  }

  it("takes only the run and pieces of the operation", () => {
    // A ran 60 min and made 80 × 30 s = 40 min of ideal time: 20 min lost
    expect(operationSpeedLossMs(wc(), "A")).toBe(20 * MIN);
    // B ran 60 min and made 50 × 60 s = 50 min: 10 min lost
    expect(operationSpeedLossMs(wc(), "B")).toBe(10 * MIN);
  });

  it("is null when the operation has no standard", () => {
    const input = wc({ idealByOperation: new Map([["A", null]]) });
    expect(operationSpeedLossMs(input, "A")).toBeNull();
  });

  it("is null when the operation never ran", () => {
    expect(operationSpeedLossMs(wc(), "C")).toBeNull();
  });
});
