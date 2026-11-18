// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { subtractIntervals } from "../scheduling/calendar-utils.ts";

/** A stretch of time in epoch milliseconds, half-open: [start, end). */
export type Interval = { start: number; end: number };

/** The intervals sorted by start and merged where they touch or overlap. */
export function unionIntervals(list: Interval[]): Interval[] {
  const sorted = list
    .filter((interval) => interval.end > interval.start)
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push(interval);
    }
  }
  return merged;
}

/** The total milliseconds the intervals cover, counting an overlap once. */
export function intervalLength(list: Interval[]): number {
  return unionIntervals(list).reduce(
    (total, interval) => total + interval.end - interval.start,
    0
  );
}

/** The time that both lists cover. */
export function intersectWindows(a: Interval[], b: Interval[]): Interval[] {
  const left = unionIntervals(a);
  const right = unionIntervals(b);
  const result: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i]!.start, right[j]!.start);
    const end = Math.min(left[i]!.end, right[j]!.end);
    if (end > start) result.push({ start, end });
    if (left[i]!.end < right[j]!.end) i++;
    else j++;
  }
  return result;
}

/** The time that `a` covers and `b` does not. */
export function subtractWindows(a: Interval[], b: Interval[]): Interval[] {
  return unionIntervals(
    subtractIntervals(unionIntervals(a), unionIntervals(b))
  );
}

/** The intervals cut to the period. */
export function clipIntervals(list: Interval[], period: Interval): Interval[] {
  return intersectWindows(list, [period]);
}

/**
 * The run intervals of a machine from its stored state changes: each
 * `Running` change runs until the next change, or until `until` when it is
 * the last one. Repeated `Running` changes are one run.
 */
export function runIntervalsFromStateChanges(
  changes: { changedAt: number; state: string }[],
  until: number
): Interval[] {
  const sorted = [...changes].sort((a, b) => a.changedAt - b.changedAt);
  const runs: Interval[] = [];
  for (let index = 0; index < sorted.length; index++) {
    const change = sorted[index]!;
    if (change.state !== "Running") continue;
    const next = sorted[index + 1];
    const end = Math.min(next ? next.changedAt : until, until);
    if (end > change.changedAt) runs.push({ start: change.changedAt, end });
  }
  return unionIntervals(runs);
}

/**
 * Every stored state of a machine as a stretch: each change holds until the
 * next one, or until `until` when it is the last. Repeated changes of one
 * state are one stretch.
 */
export function stateSegmentsFromChanges(
  changes: { changedAt: number; state: string }[],
  until: number
): (Interval & { state: string })[] {
  const sorted = [...changes].sort((a, b) => a.changedAt - b.changedAt);
  const segments: (Interval & { state: string })[] = [];
  for (let index = 0; index < sorted.length; index++) {
    const change = sorted[index]!;
    const next = sorted[index + 1];
    const end = Math.min(next ? next.changedAt : until, until);
    if (end <= change.changedAt) continue;
    const last = segments[segments.length - 1];
    if (last && last.state === change.state && last.end >= change.changedAt) {
      last.end = end;
    } else {
      segments.push({ start: change.changedAt, end, state: change.state });
    }
  }
  return segments;
}
