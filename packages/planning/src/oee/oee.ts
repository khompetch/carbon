// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

// OEE = Availability × Performance × Quality, for one work center and one
// period. Spec: .ai/specs/2026-11-14-oee-dashboard.md. Pure: the caller
// reads the rows (load.server.ts) and passes them in.

import {
  clipIntervals,
  type Interval,
  intersectWindows,
  intervalLength,
  subtractWindows,
  unionIntervals
} from "./intervals.ts";

/** A Machine production event: the operation that owns a stretch of run. */
export type OeeOwner = Interval & { jobOperationId: string };

/** Pieces counted at one moment. `bad` is Scrap + Rework. */
export type OeeCount = {
  at: number;
  /** The operation of the count, or null to take the owner of the run at `at`. */
  jobOperationId: string | null;
  total: number;
  bad: number;
};

export type OeeWorkCenterInput = {
  period: Interval;
  /** The working windows minus the Planned maintenance stops. */
  plannedWindows: Interval[];
  runIntervals: Interval[];
  owners: OeeOwner[];
  /** Ideal seconds per piece by operation; null when it has no standard. */
  idealByOperation: Map<string, number | null>;
  /** The Pulse device's ideal seconds per piece, the fallback standard. */
  deviceIdealSeconds: number | null;
  counts: OeeCount[];
};

/** The sums OEE is made of. Add parts first, then divide (`oeeRatios`). */
export type OeeParts = {
  plannedMs: number;
  runMs: number;
  runOutsideMs: number;
  runWithStandardMs: number;
  idealMs: number;
  totalPieces: number;
  badPieces: number;
};

export type OeeRatios = {
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
  standardCoverage: number | null;
};

export const EMPTY_OEE_PARTS: OeeParts = {
  plannedMs: 0,
  runMs: 0,
  runOutsideMs: 0,
  runWithStandardMs: 0,
  idealMs: 0,
  totalPieces: 0,
  badPieces: 0
};

export function computeOeeParts(input: OeeWorkCenterInput): OeeParts {
  const { period } = input;
  const planned = clipIntervals(input.plannedWindows, period);
  const run = clipIntervals(input.runIntervals, period);
  const runOutsideMs = intervalLength(subtractWindows(run, planned));
  const runMs = intervalLength(run);

  const operationIdeal = (jobOperationId: string | null) =>
    jobOperationId === null
      ? null
      : (input.idealByOperation.get(jobOperationId) ?? null);

  // The ideal of a moment: its owner's operation standard, else the device's.
  // With a device standard every moment has one; without it, only the time
  // that an operation with a standard owns.
  const runWithStandardMs =
    input.deviceIdealSeconds !== null
      ? runMs
      : intervalLength(
          intersectWindows(
            run,
            unionIntervals(
              input.owners.filter(
                (owner) => operationIdeal(owner.jobOperationId) !== null
              )
            )
          )
        );

  // A pulse bucket is counted at its end, so an owner holds (start, end].
  const ownerAt = (at: number) =>
    input.owners.find((owner) => owner.start < at && at <= owner.end)
      ?.jobOperationId ?? null;

  let idealMs = 0;
  let totalPieces = 0;
  let badPieces = 0;
  for (const count of input.counts) {
    if (count.at < period.start || count.at >= period.end) continue;
    totalPieces += count.total;
    badPieces += count.bad;
    const operation = count.jobOperationId ?? ownerAt(count.at);
    const ideal = operationIdeal(operation) ?? input.deviceIdealSeconds;
    if (ideal !== null) idealMs += ideal * count.total * 1000;
  }

  return {
    plannedMs: intervalLength(planned) + runOutsideMs,
    runMs,
    runOutsideMs,
    runWithStandardMs,
    idealMs,
    totalPieces,
    badPieces
  };
}

export function addOeeParts(a: OeeParts, b: OeeParts): OeeParts {
  return {
    plannedMs: a.plannedMs + b.plannedMs,
    runMs: a.runMs + b.runMs,
    runOutsideMs: a.runOutsideMs + b.runOutsideMs,
    runWithStandardMs: a.runWithStandardMs + b.runWithStandardMs,
    idealMs: a.idealMs + b.idealMs,
    totalPieces: a.totalPieces + b.totalPieces,
    badPieces: a.badPieces + b.badPieces
  };
}

const ratio = (part: number, whole: number) =>
  whole > 0 ? part / whole : null;

/** The OEE ratios of the parts. A ratio with nothing to divide by is null. */
export function oeeRatios(parts: OeeParts): OeeRatios {
  const availability = ratio(parts.runMs, parts.plannedMs);
  const performance = ratio(parts.idealMs, parts.runWithStandardMs);
  const quality = ratio(
    parts.totalPieces - Math.min(parts.badPieces, parts.totalPieces),
    parts.totalPieces
  );
  return {
    availability,
    performance,
    quality,
    oee:
      availability === null || performance === null || quality === null
        ? null
        : availability * performance * quality,
    standardCoverage: ratio(parts.runWithStandardMs, parts.runMs)
  };
}

/** OEE at or above this is good (the common world-class mark). */
export const OEE_GOOD = 0.85;
/** OEE below this is an alert. */
export const OEE_LOW = 0.6;

export type OeeTone = "neutral" | "good" | "warn" | "danger";

/** How an OEE value reads against `OEE_GOOD` and `OEE_LOW`. */
export function oeeTone(value: number | null | undefined): OeeTone {
  if (value === null || value === undefined) return "neutral";
  if (value >= OEE_GOOD) return "good";
  if (value >= OEE_LOW) return "warn";
  return "danger";
}
