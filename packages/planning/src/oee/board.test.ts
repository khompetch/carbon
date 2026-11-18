// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { describe, expect, it } from "vitest";
import {
  boardStates,
  buildOeeBoard,
  estimateFinish,
  spansOfOwners
} from "./board.ts";
import type { OeeWorkCenterInput } from "./oee.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (h: number, m = 0) => h * HOUR + m * MIN;
const shift = { start: at(8), end: at(20) };
// A 10-minute meeting at 8:00 and a lunch break 12:00–13:00.
const planned = [
  { start: at(8, 10), end: at(12) },
  { start: at(13), end: at(20) }
];

function input(
  overrides: Partial<Omit<OeeWorkCenterInput, "period">>
): Omit<OeeWorkCenterInput, "period"> {
  return {
    plannedWindows: planned,
    runIntervals: [],
    owners: [],
    idealByOperation: new Map([["op1", 30]]),
    deviceIdealSeconds: null,
    counts: [],
    ...overrides
  };
}

describe("boardStates", () => {
  it("counts a stop across a break only up to the break (TC9)", () => {
    const states = boardStates({
      period: { start: at(11, 30), end: at(12, 30) },
      plannedWindows: planned,
      runIntervals: [{ start: at(11, 30), end: at(11, 50) }],
      stateSegments: [{ start: at(11, 50), end: at(12, 20), state: "Down" }]
    });
    expect(states).toEqual([
      { start: at(11, 30), end: at(11, 50), state: "Running" },
      { start: at(11, 50), end: at(12), state: "Down" },
      { start: at(12), end: at(12, 30), state: "NotPlanned" }
    ]);
  });

  it("gives planned time with no state as Unknown", () => {
    const states = boardStates({
      period: { start: at(9), end: at(10) },
      plannedWindows: planned,
      runIntervals: [{ start: at(9), end: at(9, 30) }],
      stateSegments: []
    });
    expect(states.at(-1)).toEqual({
      start: at(9, 30),
      end: at(10),
      state: "Unknown"
    });
  });
});

describe("buildOeeBoard", () => {
  const run = [
    { start: at(8, 10), end: at(9) },
    { start: at(9, 20), end: at(10, 30) }
  ];
  const board = buildOeeBoard({
    input: input({
      runIntervals: run,
      owners: [{ start: at(8, 10), end: at(10, 30), jobOperationId: "op1" }],
      // 200 pieces × 30 s = 100 min of ideal time in 120 min of run.
      counts: [
        { at: at(9), jobOperationId: "op1", total: 80, bad: 0 },
        {
          at: at(10, 15),
          jobOperationId: "op1",
          total: 120,
          bad: 10,
          scrapReasonId: "flash"
        }
      ]
    }),
    stateSegments: [
      { start: at(8, 10), end: at(9), state: "Running" },
      { start: at(9), end: at(9, 20), state: "Down" },
      { start: at(9, 20), end: at(10, 30), state: "Running" }
    ],
    shift,
    now: at(10, 30)
  });

  it("measures the shift up to now", () => {
    expect(board.period).toEqual({ start: at(8), end: at(10, 30) });
    expect(board.parts.plannedMs).toBe(140 * MIN);
    expect(board.parts.runMs).toBe(120 * MIN);
    expect(board.ratios.performance).toBeCloseTo(100 / 120, 6);
  });

  it("balances: losses + good ideal time = planned time (TC10)", () => {
    const losses = board.losses.reduce((total, loss) => total + loss.ms, 0);
    expect(losses + board.goodIdealMs).toBeCloseTo(board.parts.plannedMs, 0);
    // Down 20 min, Speed 120 − 100 = 20 min, Scrap 10 × 30 s = 5 min.
    expect(board.losses).toEqual([
      { key: "Down", ms: 20 * MIN },
      { key: "Speed", ms: 20 * MIN },
      { key: "Scrap", ms: 5 * MIN }
    ]);
  });

  it("divides an hour with a break by its planned minutes (TC5)", () => {
    const hour = board.hourly.find((slot) => slot.start === at(8))!;
    expect(hour.plannedMs).toBe(50 * MIN);
    expect(board.hourly).toHaveLength(12);
    expect(board.hourly.filter((slot) => slot.isFuture)).toHaveLength(9);
    expect(board.hourly.find((slot) => slot.isCurrent)?.start).toBe(at(10));
  });

  it("lists the stop and the scrap by reason", () => {
    expect(board.stops).toEqual([
      { start: at(9), end: at(9, 20), state: "Down", open: false }
    ]);
    expect(board.scrap).toEqual([{ scrapReasonId: "flash", quantity: 10 }]);
    expect(board.current).toEqual({ state: "Running", since: at(9, 20) });
  });

  it("gives each job its own OEE", () => {
    expect(board.jobs).toHaveLength(1);
    expect(board.jobs[0]!.ratios.oee).toBeCloseTo(board.ratios.oee!, 6);
  });
});

describe("spansOfOwners", () => {
  it("gives the time between two jobs to the job that follows", () => {
    const spans = spansOfOwners(
      [
        { start: at(8, 30), end: at(9), jobOperationId: "a" },
        { start: at(9, 30), end: at(11), jobOperationId: "b" },
        { start: at(11), end: at(11, 30), jobOperationId: "b" }
      ],
      { start: at(8), end: at(12) }
    );
    expect(spans).toEqual([
      { start: at(8), end: at(9, 30), jobOperationId: "a" },
      { start: at(9, 30), end: at(12), jobOperationId: "b" }
    ]);
  });
});

describe("estimateFinish", () => {
  it("skips the time outside the working windows", () => {
    expect(
      estimateFinish({ from: at(11, 30), workMs: 60 * MIN, windows: planned })
    ).toBe(at(13, 30));
  });

  it("is null when the windows end first", () => {
    expect(
      estimateFinish({ from: at(19), workMs: 2 * HOUR, windows: planned })
    ).toBeNull();
  });
});
