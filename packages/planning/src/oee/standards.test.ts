// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { describe, expect, it } from "vitest";
import {
  deviceIdealSecondsPerPiece,
  idealSecondsPerPiece,
  type MachineUnit
} from "./standards.ts";

describe("idealSecondsPerPiece", () => {
  const cases: [MachineUnit, number, number][] = [
    ["Seconds/Piece", 9, 9],
    ["Minutes/Piece", 2, 120],
    ["Hours/Piece", 0.5, 1800],
    ["Minutes/100 Pieces", 50, 30],
    ["Minutes/1000 Pieces", 50, 3],
    ["Hours/100 Pieces", 1, 36],
    ["Hours/1000 Pieces", 1, 3.6],
    ["Pieces/Minute", 4, 15],
    ["Pieces/Hour", 400, 9]
  ];
  for (const [unit, time, expected] of cases) {
    it(`converts ${unit}`, () => {
      expect(idealSecondsPerPiece(time, unit)).toBeCloseTo(expected, 10);
    });
  }

  it("gives no standard for a machine time of 0", () => {
    expect(idealSecondsPerPiece(0, "Seconds/Piece")).toBeNull();
  });

  it("gives no standard for a total time", () => {
    expect(idealSecondsPerPiece(3, "Total Hours")).toBeNull();
    expect(idealSecondsPerPiece(30, "Total Minutes")).toBeNull();
  });
});

describe("deviceIdealSecondsPerPiece", () => {
  it("divides the cycle by the pieces per pulse", () => {
    expect(deviceIdealSecondsPerPiece(18, 2)).toBe(9);
  });

  it("gives no standard without an expected cycle", () => {
    expect(deviceIdealSecondsPerPiece(null, 2)).toBeNull();
    expect(deviceIdealSecondsPerPiece(0, 2)).toBeNull();
  });
});
