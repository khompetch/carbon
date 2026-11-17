// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { describe, expect, it } from "vitest";
import {
  addOeeParts,
  computeOeeParts,
  type OeeWorkCenterInput,
  oeeRatios,
  oeeTone
} from "./oee.ts";

const HOUR = 3_600_000;
const day = { start: 0, end: 24 * HOUR };
const shift = [{ start: 8 * HOUR, end: 16 * HOUR }];

function input(overrides: Partial<OeeWorkCenterInput>): OeeWorkCenterInput {
  return {
    period: day,
    plannedWindows: shift,
    runIntervals: [],
    owners: [],
    idealByOperation: new Map(),
    deviceIdealSeconds: null,
    counts: [],
    ...overrides
  };
}

describe("computeOeeParts", () => {
  it("gives the spec example: 75 %, 83.3 %, 98 %, 61.3 %", () => {
    const run = { start: 8 * HOUR, end: 14 * HOUR };
    const ratios = oeeRatios(
      computeOeeParts(
        input({
          runIntervals: [run],
          owners: [{ ...run, jobOperationId: "op1" }],
          idealByOperation: new Map([["op1", 9]]),
          counts: [
            { at: 10 * HOUR, jobOperationId: "op1", total: 2000, bad: 40 }
          ]
        })
      )
    );
    expect(ratios.availability).toBeCloseTo(0.75, 4);
    expect(ratios.performance).toBeCloseTo(0.8333, 4);
    expect(ratios.quality).toBeCloseTo(0.98, 4);
    expect(ratios.oee).toBeCloseTo(0.6125, 4);
    expect(ratios.standardCoverage).toBe(1);
  });

  it("adds a run past the shift end to the planned time", () => {
    const parts = computeOeeParts(
      input({ runIntervals: [{ start: 15 * HOUR, end: 18 * HOUR }] })
    );
    expect(parts.runOutsideMs).toBe(2 * HOUR);
    expect(parts.plannedMs).toBe(10 * HOUR);
    expect(parts.runMs).toBe(3 * HOUR);
  });

  it("adds a run inside a Planned stop to the planned time", () => {
    const parts = computeOeeParts(
      input({
        // 8–16 with a Planned stop 10–12 taken out.
        plannedWindows: [
          { start: 8 * HOUR, end: 10 * HOUR },
          { start: 12 * HOUR, end: 16 * HOUR }
        ],
        runIntervals: [{ start: 11 * HOUR, end: 12 * HOUR }]
      })
    );
    expect(parts.runOutsideMs).toBe(HOUR);
    expect(parts.plannedMs).toBe(7 * HOUR);
  });

  it("gives 100 % Availability to a run fully outside the shifts", () => {
    const ratios = oeeRatios(
      computeOeeParts(
        input({
          plannedWindows: [],
          runIntervals: [{ start: 20 * HOUR, end: 22 * HOUR }]
        })
      )
    );
    expect(ratios.availability).toBe(1);
  });

  it("leaves a work center with no standard out of Performance", () => {
    const run = { start: 8 * HOUR, end: 12 * HOUR };
    const ratios = oeeRatios(
      computeOeeParts(
        input({
          runIntervals: [run],
          owners: [{ ...run, jobOperationId: "op1" }],
          idealByOperation: new Map([["op1", null]]),
          counts: [{ at: 9 * HOUR, jobOperationId: "op1", total: 100, bad: 0 }]
        })
      )
    );
    expect(ratios.performance).toBeNull();
    expect(ratios.standardCoverage).toBe(0);
    expect(ratios.oee).toBeNull();
    expect(ratios.quality).toBe(1);
  });

  it("gives a pulse count the ideal of the operation that owns its time", () => {
    const run = { start: 8 * HOUR, end: 9 * HOUR };
    const parts = computeOeeParts(
      input({
        runIntervals: [run],
        owners: [{ ...run, jobOperationId: "op1" }],
        idealByOperation: new Map([["op1", 10]]),
        deviceIdealSeconds: 99,
        counts: [{ at: 9 * HOUR, jobOperationId: null, total: 360, bad: 0 }]
      })
    );
    expect(parts.idealMs).toBe(360 * 10 * 1000);
  });

  it("uses the device standard for run time that no operation owns", () => {
    const parts = computeOeeParts(
      input({
        runIntervals: [{ start: 8 * HOUR, end: 9 * HOUR }],
        deviceIdealSeconds: 12,
        counts: [{ at: 8.5 * HOUR, jobOperationId: null, total: 300, bad: 0 }]
      })
    );
    expect(parts.runWithStandardMs).toBe(HOUR);
    expect(parts.idealMs).toBe(300 * 12 * 1000);
  });

  it("counts only the pieces inside the period", () => {
    const parts = computeOeeParts(
      input({
        counts: [{ at: 25 * HOUR, jobOperationId: null, total: 5, bad: 1 }]
      })
    );
    expect(parts.totalPieces).toBe(0);
    expect(parts.badPieces).toBe(0);
  });
});

describe("addOeeParts", () => {
  it("rolls up sums, not the average of percentages", () => {
    const busy = computeOeeParts(
      input({
        runIntervals: shift,
        owners: [{ ...shift[0]!, jobOperationId: "op1" }],
        idealByOperation: new Map([["op1", 10]]),
        counts: [{ at: 9 * HOUR, jobOperationId: "op1", total: 2880, bad: 0 }]
      })
    );
    const quiet = computeOeeParts(
      input({
        plannedWindows: [{ start: 8 * HOUR, end: 9 * HOUR }],
        runIntervals: [{ start: 8 * HOUR, end: 8.5 * HOUR }],
        owners: [{ start: 8 * HOUR, end: 8.5 * HOUR, jobOperationId: "op1" }],
        idealByOperation: new Map([["op1", 10]]),
        counts: [{ at: 8.2 * HOUR, jobOperationId: "op1", total: 180, bad: 0 }]
      })
    );
    const busyOee = oeeRatios(busy).oee!;
    const quietOee = oeeRatios(quiet).oee!;
    const rolledUp = oeeRatios(addOeeParts(busy, quiet)).oee!;
    expect(busyOee).toBeCloseTo(1, 6);
    expect(quietOee).toBeCloseTo(0.5, 6);
    expect(rolledUp).toBeCloseTo(8.5 / 9, 6);
    expect(rolledUp).not.toBeCloseTo((busyOee + quietOee) / 2, 3);
  });
});

describe("oeeTone", () => {
  it.each([
    [null, "neutral"],
    [0.85, "good"],
    [0.8499, "warn"],
    [0.6, "warn"],
    [0.5999, "danger"]
  ] as const)("reads %s as %s", (value, tone) => {
    expect(oeeTone(value)).toBe(tone);
  });
});
