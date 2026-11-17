// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { describe, expect, it } from "vitest";
import {
  clipIntervals,
  intersectWindows,
  intervalLength,
  runIntervalsFromStateChanges,
  subtractWindows,
  unionIntervals
} from "./intervals.ts";

describe("unionIntervals", () => {
  it("merges overlapping and touching intervals", () => {
    expect(
      unionIntervals([
        { start: 5, end: 8 },
        { start: 0, end: 3 },
        { start: 2, end: 5 },
        { start: 10, end: 10 }
      ])
    ).toEqual([{ start: 0, end: 8 }]);
  });

  it("gives nothing for an empty list", () => {
    expect(unionIntervals([])).toEqual([]);
    expect(intervalLength([])).toBe(0);
  });
});

describe("window math", () => {
  const shifts = [
    { start: 0, end: 10 },
    { start: 20, end: 30 }
  ];

  it("intersects two lists", () => {
    expect(intersectWindows(shifts, [{ start: 5, end: 25 }])).toEqual([
      { start: 5, end: 10 },
      { start: 20, end: 25 }
    ]);
  });

  it("subtracts a list", () => {
    expect(subtractWindows([{ start: 5, end: 25 }], shifts)).toEqual([
      { start: 10, end: 20 }
    ]);
  });

  it("clips a run that crosses the period end", () => {
    expect(
      clipIntervals([{ start: 25, end: 40 }], { start: 0, end: 30 })
    ).toEqual([{ start: 25, end: 30 }]);
  });
});

describe("runIntervalsFromStateChanges", () => {
  it("runs from each Running change to the next change", () => {
    expect(
      runIntervalsFromStateChanges(
        [
          { changedAt: 0, state: "Running" },
          { changedAt: 10, state: "Idle" },
          { changedAt: 20, state: "Running" },
          { changedAt: 25, state: "Offline" }
        ],
        100
      )
    ).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 25 }
    ]);
  });

  it("runs the last Running change until the end", () => {
    expect(
      runIntervalsFromStateChanges([{ changedAt: 50, state: "Running" }], 80)
    ).toEqual([{ start: 50, end: 80 }]);
  });

  it("treats 2 Running changes in a row as one run", () => {
    expect(
      runIntervalsFromStateChanges(
        [
          { changedAt: 10, state: "Running" },
          { changedAt: 0, state: "Running" },
          { changedAt: 30, state: "Idle" }
        ],
        100
      )
    ).toEqual([{ start: 0, end: 30 }]);
  });
});
