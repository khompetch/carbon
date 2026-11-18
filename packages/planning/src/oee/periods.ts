// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import {
  fromAbsolute,
  getDayOfWeek,
  parseDate,
  parseTime,
  toCalendarDate,
  toCalendarDateTime,
  toZoned
} from "@internationalized/date";
import type { ShiftRow } from "../scheduling/work-center-windows.ts";
import { type Interval, unionIntervals } from "./intervals.ts";

/**
 * The shift an MES board shows: the working window that holds `now`, from
 * its start to now. Between shifts, the window that ended last. Null when no
 * window started before `now`.
 */
export function currentShiftPeriod(
  windows: Interval[],
  now: number
): Interval | null {
  const merged = unionIntervals(windows);
  let last: Interval | null = null;
  for (const window of merged) {
    if (window.start <= now && now < window.end) {
      return { start: window.start, end: now };
    }
    if (window.end <= now) last = window;
  }
  return last ? { start: last.start, end: last.end } : null;
}

/** The current local day, from midnight in `timeZone` to `now`. */
export function localDayPeriod(now: number, timeZone: string): Interval {
  const day = toCalendarDate(fromAbsolute(now, timeZone));
  return { start: day.toDate(timeZone).getTime(), end: now };
}

/**
 * One period per local day from `fromDate` to `toDate` ("YYYY-MM-DD", both
 * inclusive). A day across a DST change is 23 or 25 hours long.
 */
export function dayPeriods(
  fromDate: string,
  toDate: string,
  timeZone: string
): { day: string; period: Interval }[] {
  const last = parseDate(toDate);
  const days: { day: string; period: Interval }[] = [];
  for (
    let day = parseDate(fromDate);
    day.compare(last) <= 0;
    day = day.add({ days: 1 })
  ) {
    days.push({
      day: day.toString(),
      period: {
        start: day.toDate(timeZone).getTime(),
        end: day.add({ days: 1 }).toDate(timeZone).getTime()
      }
    });
  }
  return days;
}

// Day flags by `CalendarDate` day of week, Sunday first (en-US).
const DAY_FLAGS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
] as const;

/**
 * Every moment a shift starts between `from` and `to`, on the shifts' local
 * clock. The working windows merge two shifts that run back to back; these
 * instants cut them apart again (`splitAtShiftStarts`).
 */
export function shiftStartInstants(
  shifts: ShiftRow[],
  timeZone: string,
  from: number,
  to: number
): number[] {
  const starts = new Set<number>();
  const last = toCalendarDate(fromAbsolute(to, timeZone));
  for (const shift of shifts) {
    if (!shift.startTime) continue;
    const time = parseTime(String(shift.startTime));
    for (
      let day = toCalendarDate(fromAbsolute(from, timeZone)).subtract({
        days: 1
      });
      day.compare(last) <= 0;
      day = day.add({ days: 1 })
    ) {
      const flag = DAY_FLAGS[getDayOfWeek(day, "en-US")];
      if (!flag || !shift[flag]) continue;
      const at = toZoned(toCalendarDateTime(day, time), timeZone)
        .toDate()
        .getTime();
      if (at >= from && at <= to) starts.add(at);
    }
  }
  return [...starts].sort((a, b) => a - b);
}

/** The windows merged, then cut at every shift start inside them. */
export function splitAtShiftStarts(
  windows: Interval[],
  starts: number[]
): Interval[] {
  const result: Interval[] = [];
  for (const window of unionIntervals(windows)) {
    let start = window.start;
    for (const cut of starts) {
      if (cut > start && cut < window.end) {
        result.push({ start, end: cut });
        start = cut;
      }
    }
    result.push({ start, end: window.end });
  }
  return result;
}

/**
 * The whole shift window an MES board shows: the one that holds `now`, else
 * the one that ended last. Null when no window started before `now`. Pass
 * windows cut by `splitAtShiftStarts`.
 */
export function shiftWindowAt(
  windows: Interval[],
  now: number
): Interval | null {
  let last: Interval | null = null;
  for (const window of windows) {
    if (window.start <= now && now < window.end) return window;
    if (window.end <= now && (!last || window.end >= last.end)) last = window;
  }
  return last;
}

/** The shift window that ended last before `current` started. */
export function previousShiftWindow(
  windows: Interval[],
  current: Interval
): Interval | null {
  let last: Interval | null = null;
  for (const window of windows) {
    if (window.end <= current.start && (!last || window.end > last.end)) {
      last = window;
    }
  }
  return last;
}
