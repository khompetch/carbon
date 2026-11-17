// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

// A work center's working windows (shifts, holidays, maintenance outages) and
// its working hours per plant day. Pure: no database, no env. Used by the
// ERP's capacity and priority views and by the OEE screens (ERP and MES).

import { parseDate } from "@internationalized/date";
import { type CalendarWindow, subtractIntervals } from "./calendar-utils.ts";
import { HOUR_MS } from "./date-utils.ts";
import {
  closeHolidays,
  type LadderShiftRow,
  resolveWorkCenterWindows
} from "./machine-availability.ts";

/** The `shift` rows returned by getShiftsWithTimes (weekday flags + times). */
export type ShiftRow = {
  startTime: string | null;
  endTime: string | null;
  monday: boolean | null;
  tuesday: boolean | null;
  wednesday: boolean | null;
  thursday: boolean | null;
  friday: boolean | null;
  saturday: boolean | null;
  sunday: boolean | null;
};

// dayOfWeek 0 = Sunday .. 6 = Saturday — the ladder's convention, matching the
// scheduler's own location-shift mapping (master-data-provider.expandShiftDays).
const WEEKDAY_FLAGS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
] as const;

/** A shift's weekday windows in the ladder's row shape (0 = Sunday). */
export function expandShiftRows(shifts: ShiftRow[], timeZone: string) {
  const rows: LadderShiftRow[] = [];
  for (const shift of shifts) {
    if (!shift.startTime || !shift.endTime) continue;
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      const flag = WEEKDAY_FLAGS[dayOfWeek];
      if (!flag || !shift[flag]) continue;
      rows.push({
        dayOfWeek,
        startTime: String(shift.startTime),
        endTime: String(shift.endTime),
        timezone: timeZone
      });
    }
  }
  return rows;
}

/**
 * Each work center's working windows: the scheduler's availability ladder
 * (`resolveWorkCenterWindows`) minus the company's holidays.
 */
export function getWorkCenterWorkingWindows(args: {
  workCenters: { id: string; alwaysOn: boolean }[];
  workCenterShifts: { workCenterId: string; shiftId: string }[];
  /** The location's active shifts. */
  shifts: (ShiftRow & { id: string })[];
  /** Shifts a work center is linked to at another location. */
  linkedShifts?: (ShiftRow & { id: string })[];
  timeZone: string;
  holidayDates: Set<string>;
  rangeStart: number;
  rangeEnd: number;
}): Map<string, CalendarWindow[]> {
  const { workCenters, workCenterShifts, shifts, timeZone } = args;
  const shiftById = new Map(
    [...shifts, ...(args.linkedShifts ?? [])].map((shift) => [shift.id, shift])
  );
  const ladderWorkCenters = workCenters.map((wc) => ({
    id: wc.id,
    alwaysOn: wc.alwaysOn,
    locationId: "location",
    timezone: timeZone
  }));
  const windows = resolveWorkCenterWindows({
    workCenters: ladderWorkCenters,
    workCenterShiftRows: workCenterShifts.flatMap((link) => {
      const shift = shiftById.get(link.shiftId);
      return shift
        ? expandShiftRows([shift], timeZone).map((row) => ({
            ...row,
            workCenterId: link.workCenterId
          }))
        : [];
    }),
    locationShiftRows: expandShiftRows(shifts, timeZone).map((row) => ({
      ...row,
      locationId: "location"
    })),
    rangeStart: args.rangeStart,
    rangeEnd: args.rangeEnd
  });
  return closeHolidays({
    windowsByWorkCenter: windows,
    workCenters: ladderWorkCenters,
    holidayDates: args.holidayDates
  });
}

/**
 * The windows a station can work: its working windows with its maintenance
 * outages taken out — what the scheduler places work in.
 */
export function withoutOutages(
  windowsByWorkCenter: Map<string, CalendarWindow[]>,
  outagesByWorkCenter: Map<string, CalendarWindow[]>
): Map<string, CalendarWindow[]> {
  const result = new Map(windowsByWorkCenter);
  for (const [workCenterId, outages] of outagesByWorkCenter) {
    const windows = result.get(workCenterId);
    if (windows) result.set(workCenterId, subtractIntervals(windows, outages));
  }
  return result;
}

/** Each week date's bounds on the plant's calendar (DST-aware). */
export function plantDayBounds(weekDates: string[], timezone: string) {
  return weekDates.map((day) => {
    const dayDate = parseDate(day);
    return {
      day,
      startMs: dayDate.toDate(timezone).getTime(),
      endMs: dayDate.add({ days: 1 }).toDate(timezone).getTime()
    };
  });
}

/**
 * Working hours per plant day for each work center: the Capacity view's
 * Available series, read off the windows the scheduler places work in
 * (shifts, holidays, maintenance downtime). A lights-out station's day is the
 * length of that local day, 23 or 25 hours across a DST change.
 */
export function workingHoursByDay(args: {
  windowsByWorkCenter: Map<string, CalendarWindow[]>;
  weekDates: string[];
  timezone: string;
}): Map<string, Map<string, number>> {
  const days = plantDayBounds(args.weekDates, args.timezone);
  const result = new Map<string, Map<string, number>>();
  for (const [workCenterId, windows] of args.windowsByWorkCenter) {
    result.set(
      workCenterId,
      new Map(
        days.map(({ day, startMs, endMs }) => [
          day,
          workingOverlapMs(windows, startMs, endMs) / HOUR_MS
        ])
      )
    );
  }
  return result;
}

/** Milliseconds of `windows` inside [from, to). */
export function workingOverlapMs(
  windows: CalendarWindow[],
  from: number,
  to: number
): number {
  let total = 0;
  for (const window of windows) {
    const overlap = Math.min(to, window.end) - Math.max(from, window.start);
    if (overlap > 0) total += overlap;
  }
  return total;
}
