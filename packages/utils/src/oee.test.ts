import { describe, expect, it } from "vitest";
import {
  clampInterval,
  computeShiftHourlyOee,
  mergedDuration,
  standardMsPerPiece
} from "./oee";

const HOUR = 3_600_000;
const MINUTE = 60_000;

// Day shift 08:00-20:00 UTC on an arbitrary date
const SHIFT_START = Date.parse("2026-07-16T08:00:00Z");
const SHIFT_END = SHIFT_START + 12 * HOUR;

const iso = (offsetMs: number) =>
  new Date(SHIFT_START + offsetMs).toISOString();

describe("standardMsPerPiece", () => {
  it("converts per-piece and rate units", () => {
    expect(standardMsPerPiece(1, "Hours/Piece")).toBe(HOUR);
    expect(standardMsPerPiece(30, "Minutes/Piece")).toBe(30 * MINUTE);
    expect(standardMsPerPiece(2, "Hours/100 Pieces")).toBe((2 * HOUR) / 100);
    expect(standardMsPerPiece(400, "Seconds/Piece")).toBe(400_000);
    expect(standardMsPerPiece(9, "Pieces/Hour")).toBe(HOUR / 9);
    expect(standardMsPerPiece(2, "Pieces/Minute")).toBe(MINUTE / 2);
  });

  it("returns 0 for fixed allowances and unknown units", () => {
    expect(standardMsPerPiece(4, "Total Hours")).toBe(0);
    expect(standardMsPerPiece(4, "Total Minutes")).toBe(0);
    expect(standardMsPerPiece(4, null)).toBe(0);
    expect(standardMsPerPiece(0, "Hours/Piece")).toBe(0);
  });
});

describe("mergedDuration / clampInterval", () => {
  it("merges overlapping intervals", () => {
    expect(
      mergedDuration([
        [0, HOUR],
        [30 * MINUTE, 90 * MINUTE],
        [3 * HOUR, 4 * HOUR]
      ])
    ).toBe(90 * MINUTE + HOUR);
  });

  it("clamps to a window", () => {
    expect(clampInterval([0, 2 * HOUR], HOUR, 3 * HOUR)).toEqual([
      HOUR,
      2 * HOUR
    ]);
    expect(clampInterval([0, HOUR], 2 * HOUR, 3 * HOUR)).toBeNull();
  });
});

describe("computeShiftHourlyOee", () => {
  const standard = {
    jobOperationId: "op1",
    setupTime: 0,
    setupUnit: "Total Hours",
    laborTime: 0,
    laborUnit: "Hours/Piece",
    machineTime: 6, // 6 minutes per piece → 10 pcs/hour target
    machineUnit: "Minutes/Piece"
  };

  it("buckets a full running hour with pieces", () => {
    const { hours } = computeShiftHourlyOee({
      shiftStart: SHIFT_START,
      shiftEnd: SHIFT_END,
      now: SHIFT_START + 2 * HOUR, // two hours into the shift
      events: [
        {
          startTime: iso(0),
          endTime: iso(HOUR),
          type: "Machine",
          jobOperationId: "op1"
        }
      ],
      quantities: [
        {
          createdAt: iso(30 * MINUTE),
          type: "Production",
          quantity: 8,
          jobOperationId: "op1"
        },
        {
          createdAt: iso(45 * MINUTE),
          type: "Scrap",
          quantity: 2,
          jobOperationId: "op1"
        }
      ],
      standards: [standard],
      plannedDowntimes: []
    });

    expect(hours).toHaveLength(12);
    const first = hours[0]!;
    expect(first.elapsedMs).toBe(HOUR);
    expect(first.runtimeMs).toBe(HOUR);
    expect(first.pdtMs).toBe(0);
    expect(first.updtMs).toBe(0);
    expect(first.good).toBe(8);
    expect(first.defect).toBe(2);
    expect(first.target).toBe(10);
    expect(first.availability).toBeCloseTo(1);
    // 8 pieces × 6 min = 48 min earned over 60 min runtime
    expect(first.performance).toBeCloseTo(0.8);
    expect(first.quality).toBeCloseTo(0.8);
    expect(first.oee).toBeCloseTo(0.64);
  });

  it("treats idle in-shift time as unplanned downtime", () => {
    const { hours } = computeShiftHourlyOee({
      shiftStart: SHIFT_START,
      shiftEnd: SHIFT_END,
      now: SHIFT_START + HOUR,
      events: [
        {
          startTime: iso(0),
          endTime: iso(20 * MINUTE),
          type: "Machine",
          jobOperationId: "op1"
        }
      ],
      quantities: [],
      standards: [standard],
      plannedDowntimes: [
        // 10 minutes of planned break inside the first hour
        { startTime: iso(30 * MINUTE), endTime: iso(40 * MINUTE) }
      ]
    });

    const first = hours[0]!;
    expect(first.pdtMs).toBe(10 * MINUTE);
    expect(first.runtimeMs).toBe(20 * MINUTE);
    expect(first.updtMs).toBe(30 * MINUTE);
    // %A = 20 / (60 - 10)
    expect(first.availability).toBeCloseTo(20 / 50);
    // target from available time: 50 min / 6 min per piece ≈ 8
    expect(first.target).toBe(8);
  });

  it("clamps open events and downtimes to now and nulls future hours", () => {
    const now = SHIFT_START + 90 * MINUTE;
    const { hours } = computeShiftHourlyOee({
      shiftStart: SHIFT_START,
      shiftEnd: SHIFT_END,
      now,
      events: [
        {
          startTime: iso(0),
          endTime: null, // still running
          type: "Machine",
          jobOperationId: "op1"
        }
      ],
      quantities: [],
      standards: [standard],
      plannedDowntimes: [
        { startTime: iso(70 * MINUTE), endTime: null } // open planned downtime
      ]
    });

    expect(hours[0]!.runtimeMs).toBe(HOUR);
    // second bucket has elapsed 30 min: runtime clamped to now,
    // open planned downtime covers minutes 70-90 and wins over the
    // still-running event, so runtime = 30 - 20 overlapping minutes
    expect(hours[1]!.elapsedMs).toBe(30 * MINUTE);
    expect(hours[1]!.runtimeMs).toBe(10 * MINUTE);
    expect(hours[1]!.pdtMs).toBe(20 * MINUTE);
    // future buckets are inert
    expect(hours[2]!.elapsedMs).toBe(0);
    expect(hours[2]!.availability).toBeNull();
    expect(hours[2]!.oee).toBeNull();
  });

  it("spans events across bucket boundaries and computes totals", () => {
    const { hours, totals } = computeShiftHourlyOee({
      shiftStart: SHIFT_START,
      shiftEnd: SHIFT_END,
      now: SHIFT_END + HOUR, // shift over
      events: [
        {
          // 07:30-09:30 — clamps to shift start, spans two buckets
          startTime: new Date(SHIFT_START - 30 * MINUTE).toISOString(),
          endTime: iso(90 * MINUTE),
          type: "Machine",
          jobOperationId: "op1"
        }
      ],
      quantities: [
        {
          createdAt: iso(80 * MINUTE),
          type: "Production",
          quantity: 5,
          jobOperationId: "op1"
        }
      ],
      standards: [standard],
      plannedDowntimes: []
    });

    expect(hours[0]!.runtimeMs).toBe(HOUR);
    expect(hours[1]!.runtimeMs).toBe(30 * MINUTE);
    expect(hours[1]!.good).toBe(5);
    expect(totals.elapsedMs).toBe(12 * HOUR);
    expect(totals.runtimeMs).toBe(90 * MINUTE);
    expect(totals.good).toBe(5);
    // totals earned: 5 × 6 min = 30 min over 90 min runtime
    expect(totals.performance).toBeCloseTo(1 / 3);
  });

  it("handles an overnight shift window (20:00-08:00)", () => {
    const nightStart = Date.parse("2026-07-16T20:00:00Z");
    const nightEnd = nightStart + 12 * HOUR; // 08:00 next day
    const { hours } = computeShiftHourlyOee({
      shiftStart: nightStart,
      shiftEnd: nightEnd,
      now: nightStart + 5 * HOUR + 30 * MINUTE, // 01:30 next day
      events: [
        {
          // 23:30 - 00:30: spans midnight
          startTime: new Date(nightStart + 3.5 * HOUR).toISOString(),
          endTime: new Date(nightStart + 4.5 * HOUR).toISOString(),
          type: "Machine",
          jobOperationId: "op1"
        }
      ],
      quantities: [],
      standards: [standard],
      plannedDowntimes: []
    });

    expect(hours).toHaveLength(12);
    expect(hours[3]!.runtimeMs).toBe(30 * MINUTE); // 23:00-00:00 bucket
    expect(hours[4]!.runtimeMs).toBe(30 * MINUTE); // 00:00-01:00 bucket
    expect(hours[5]!.elapsedMs).toBe(30 * MINUTE); // current partial hour
    expect(hours[6]!.elapsedMs).toBe(0); // future
  });

  it("earns no credit for setup events — %P counts pieces only", () => {
    const setupStandard = {
      ...standard,
      setupTime: 1,
      setupUnit: "Total Hours"
    };
    const { hours } = computeShiftHourlyOee({
      shiftStart: SHIFT_START,
      shiftEnd: SHIFT_END,
      now: SHIFT_START + 2 * HOUR,
      events: [
        {
          // setup ran 30 min in hour 1 and 30 min in hour 2
          startTime: iso(30 * MINUTE),
          endTime: iso(90 * MINUTE),
          type: "Setup",
          jobOperationId: "op1"
        }
      ],
      quantities: [],
      standards: [setupStandard],
      plannedDowntimes: []
    });

    // setup counts as runtime but earns nothing — it shows as %P loss,
    // never as earned credit that could push %P past 100
    expect(hours[0]!.runtimeMs).toBe(30 * MINUTE);
    expect(hours[0]!.earnedMs).toBe(0);
    expect(hours[0]!.performance).toBe(0);
    expect(hours[1]!.earnedMs).toBe(0);
  });
});

describe("shift windows", () => {
  const dayShift = {
    id: "day",
    startTime: "08:00:00",
    endTime: "20:00:00",
    sunday: false,
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: true,
    saturday: false
  };
  const nightShift = {
    ...dayShift,
    id: "night",
    startTime: "20:00:00",
    endTime: "08:00:00"
  };

  it("resolves a same-day window and respects day flags", async () => {
    const { resolveShiftWindow } = await import("./oee");
    // 2026-07-16 is a Thursday
    const window = resolveShiftWindow(dayShift, "2026-07-16", "UTC");
    expect(window).not.toBeNull();
    expect(window!.start).toBe(Date.parse("2026-07-16T08:00:00Z"));
    expect(window!.end).toBe(Date.parse("2026-07-16T20:00:00Z"));
    // 2026-07-18 is a Saturday — flag off
    expect(resolveShiftWindow(dayShift, "2026-07-18", "UTC")).toBeNull();
  });

  it("resolves an overnight window across midnight", async () => {
    const { resolveShiftWindow } = await import("./oee");
    const window = resolveShiftWindow(nightShift, "2026-07-16", "UTC");
    expect(window!.start).toBe(Date.parse("2026-07-16T20:00:00Z"));
    expect(window!.end).toBe(Date.parse("2026-07-17T08:00:00Z"));
  });

  it("finds the active shift, including after midnight of a night shift", async () => {
    const { findActiveShiftWindow } = await import("./oee");
    const shifts = [dayShift, nightShift];

    const midMorning = Date.parse("2026-07-16T10:30:00Z");
    expect(findActiveShiftWindow(shifts, midMorning, "UTC")?.shift.id).toBe(
      "day"
    );

    // 02:00 Friday — inside Thursday's night shift
    const lateNight = Date.parse("2026-07-17T02:00:00Z");
    const active = findActiveShiftWindow(shifts, lateNight, "UTC");
    expect(active?.shift.id).toBe("night");
    expect(active?.start).toBe(Date.parse("2026-07-16T20:00:00Z"));
  });

  it("respects the location timezone", async () => {
    const { resolveShiftWindow } = await import("./oee");
    const window = resolveShiftWindow(
      dayShift,
      "2026-07-16",
      "Asia/Bangkok" // UTC+7
    );
    expect(window!.start).toBe(Date.parse("2026-07-16T01:00:00Z"));
  });
});

describe("subtractIntervals / downtime wins runtime", () => {
  it("subtracts overlapping intervals", async () => {
    const { subtractIntervals } = await import("./oee");
    expect(
      subtractIntervals(
        [[0, HOUR]],
        [
          [10 * MINUTE, 20 * MINUTE],
          [50 * MINUTE, 2 * HOUR]
        ]
      )
    ).toEqual([
      [0, 10 * MINUTE],
      [20 * MINUTE, 50 * MINUTE]
    ]);
    expect(subtractIntervals([[0, HOUR]], [[0, 2 * HOUR]])).toEqual([]);
  });

  it("recorded unplanned downtime over an open event reduces %A", () => {
    const { hours } = computeShiftHourlyOee({
      shiftStart: SHIFT_START,
      shiftEnd: SHIFT_END,
      now: SHIFT_START + HOUR,
      events: [
        {
          startTime: iso(0),
          endTime: null, // operator left it running
          type: "Machine",
          jobOperationId: "op1"
        }
      ],
      quantities: [],
      standards: [
        {
          jobOperationId: "op1",
          setupTime: 0,
          setupUnit: "Total Hours",
          laborTime: 0,
          laborUnit: "Hours/Piece",
          machineTime: 6,
          machineUnit: "Minutes/Piece"
        }
      ],
      plannedDowntimes: [],
      unplannedDowntimes: [
        { startTime: iso(30 * MINUTE), endTime: null } // machine down
      ]
    });

    const first = hours[0]!;
    expect(first.runtimeMs).toBe(30 * MINUTE);
    expect(first.updtMs).toBe(30 * MINUTE);
    expect(first.availability).toBeCloseTo(0.5);
  });
});

describe("detectNoOutput", () => {
  const sixMinutes = 6 * MINUTE;

  const openEvent = {
    startTime: iso(0),
    endTime: null,
    type: "Machine" as const,
    jobOperationId: "op1"
  };

  it("triggers after multiplier × cycle time with no output", async () => {
    const { detectNoOutput } = await import("./oee");
    // threshold = 2 × 6min = 12min; 20 min elapsed with no output
    expect(
      detectNoOutput({
        events: [openEvent],
        quantities: [],
        msPerPiece: sixMinutes,
        multiplier: 2,
        now: SHIFT_START + 20 * MINUTE
      })
    ).toBe(SHIFT_START + 12 * MINUTE);
  });

  it("does not trigger before the threshold or without an open event", async () => {
    const { detectNoOutput } = await import("./oee");
    expect(
      detectNoOutput({
        events: [openEvent],
        quantities: [],
        msPerPiece: sixMinutes,
        multiplier: 2,
        now: SHIFT_START + 10 * MINUTE
      })
    ).toBeNull();
    expect(
      detectNoOutput({
        events: [{ ...openEvent, endTime: iso(30 * MINUTE) }],
        quantities: [],
        msPerPiece: sixMinutes,
        multiplier: 2,
        now: SHIFT_START + HOUR
      })
    ).toBeNull();
  });

  it("ignores open Setup events — setup legitimately has no output", async () => {
    const { detectNoOutput } = await import("./oee");
    // only a Setup event open → no detection at all
    expect(
      detectNoOutput({
        events: [{ ...openEvent, type: "Setup" as const }],
        quantities: [],
        msPerPiece: sixMinutes,
        multiplier: 2,
        now: SHIFT_START + HOUR
      })
    ).toBeNull();
    // Setup + Machine open: the clock runs from the Machine event only
    expect(
      detectNoOutput({
        events: [
          { ...openEvent, type: "Setup" as const },
          { ...openEvent, startTime: iso(5 * MINUTE) }
        ],
        quantities: [],
        msPerPiece: sixMinutes,
        multiplier: 2,
        now: SHIFT_START + 20 * MINUTE
      })
    ).toBe(SHIFT_START + 17 * MINUTE);
  });

  it("resets the clock when output is logged", async () => {
    const { detectNoOutput } = await import("./oee");
    expect(
      detectNoOutput({
        events: [openEvent],
        quantities: [
          {
            createdAt: iso(15 * MINUTE),
            type: "Production",
            quantity: 1,
            jobOperationId: "op1"
          }
        ],
        msPerPiece: sixMinutes,
        multiplier: 2,
        now: SHIFT_START + 20 * MINUTE
      })
    ).toBeNull();
  });

  it("does not trigger without a cycle time", async () => {
    const { detectNoOutput } = await import("./oee");
    expect(
      detectNoOutput({
        events: [openEvent],
        quantities: [],
        msPerPiece: 0,
        multiplier: 2,
        now: SHIFT_START + HOUR
      })
    ).toBeNull();
  });

  it("virtual no-output window flows into the hourly math", () => {
    const { hours } = computeShiftHourlyOee({
      shiftStart: SHIFT_START,
      shiftEnd: SHIFT_END,
      now: SHIFT_START + 30 * MINUTE,
      events: [openEvent],
      quantities: [],
      standards: [
        {
          jobOperationId: "op1",
          setupTime: 0,
          setupUnit: "Total Hours",
          laborTime: 0,
          laborUnit: "Hours/Piece",
          machineTime: 6,
          machineUnit: "Minutes/Piece"
        }
      ],
      plannedDowntimes: [],
      noOutput: { msPerPiece: sixMinutes, multiplier: 2 }
    });

    // threshold crossed at minute 12; minutes 12-30 become downtime
    const first = hours[0]!;
    expect(first.runtimeMs).toBe(12 * MINUTE);
    expect(first.updtMs).toBe(18 * MINUTE);
    expect(first.availability).toBeCloseTo(12 / 30);
  });
});
