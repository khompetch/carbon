// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import {
  fromAbsolute,
  parseDate,
  toCalendarDate
} from "@internationalized/date";
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
