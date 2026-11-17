// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { parseZonedDateTime } from "@internationalized/date";
import { describe, expect, it } from "vitest";
import { currentShiftPeriod, dayPeriods, localDayPeriod } from "./periods.ts";

const HOUR = 3_600_000;
const at = (value: string) => parseZonedDateTime(value).toDate().getTime();

describe("currentShiftPeriod", () => {
  const shifts = [
    { start: 8 * HOUR, end: 12 * HOUR },
    { start: 12 * HOUR, end: 16 * HOUR },
    { start: 20 * HOUR, end: 24 * HOUR }
  ];

  it("gives the shift that holds now, up to now", () => {
    expect(currentShiftPeriod(shifts, 13 * HOUR)).toEqual({
      start: 8 * HOUR,
      end: 13 * HOUR
    });
  });

  it("gives the shift that ended last between 2 shifts", () => {
    expect(currentShiftPeriod(shifts, 18 * HOUR)).toEqual({
      start: 8 * HOUR,
      end: 16 * HOUR
    });
  });

  it("gives null before the first shift", () => {
    expect(currentShiftPeriod(shifts, 7 * HOUR)).toBeNull();
  });
});

describe("localDayPeriod", () => {
  it("starts at local midnight in Asia/Bangkok", () => {
    const now = at("2026-11-17T09:30[Asia/Bangkok]");
    expect(localDayPeriod(now, "Asia/Bangkok")).toEqual({
      start: at("2026-11-17T00:00[Asia/Bangkok]"),
      end: now
    });
  });
});

describe("dayPeriods", () => {
  it("gives one period per day, both dates inclusive", () => {
    const days = dayPeriods("2026-11-16", "2026-11-17", "Asia/Bangkok");
    expect(days.map((d) => d.day)).toEqual(["2026-11-16", "2026-11-17"]);
    expect(days[0]!.period.end - days[0]!.period.start).toBe(24 * HOUR);
  });

  it("gives a 23-hour day at the spring DST change", () => {
    const [day] = dayPeriods("2026-03-08", "2026-03-08", "America/New_York");
    expect(day!.period.end - day!.period.start).toBe(23 * HOUR);
  });
});
