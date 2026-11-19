// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

// The MES OEE line board of one work center and one shift: everything the
// wall screen draws, computed here so every screen shows the same numbers.
// Pure: the caller loads the rows (load.server.ts). Losses follow the earned
// time rule: planned time = run + stops, run = ideal time made + speed loss,
// ideal time made = good ideal time + scrap.

import {
  clipIntervals,
  type Interval,
  intersectWindows,
  intervalLength,
  subtractWindows,
  unionIntervals
} from "./intervals.ts";
import {
  addOeeParts,
  computeOeeParts,
  countIdealSeconds,
  EMPTY_OEE_PARTS,
  type OeeParts,
  type OeeRatios,
  type OeeWorkCenterInput,
  oeeRatios,
  shownOee
} from "./oee.ts";

const HOUR_MS = 3_600_000;
const MAX_HOURS = 24;
/** A stop shorter than this is not listed in the stop log. */
export const STOP_LOG_MIN_MS = 2 * 60_000;
const STOP_LOG_SIZE = 5;
const LOSS_LIST_SIZE = 6;

/** A machine state from `machineStateChange`, held until the next change. */
export type OeeStateSegment = Interval & { state: string };

/**
 * What the machine did at each moment of the shift. `Unknown` is planned
 * time with no state (an Operator work center, or no signal); `NotPlanned`
 * is time outside the working windows that did not run.
 */
export type OeeBoardState =
  | "Running"
  | "Idle"
  | "Down"
  | "Offline"
  | "Unknown"
  | "NotPlanned";

export type OeeLossKey =
  | "Down"
  | "Idle"
  | "Offline"
  | "Unknown"
  | "Speed"
  | "Scrap";

export type OeeBoardJob = {
  jobOperationId: string;
  parts: OeeParts;
  ratios: OeeRatios;
  /** The OEE to show (`shownOee`). */
  oee: number | null;
};

export type OeeBoardHour = Interval & {
  plannedMs: number;
  idealMs: number;
  /** Ideal time made ÷ planned time. Null when the hour has no planned time. */
  efficiency: number | null;
  isCurrent: boolean;
  isFuture: boolean;
  /** Another operation took over the work center in this hour. */
  jobChange: boolean;
};

export type OeeBoardStop = Interval & {
  state: Exclude<OeeBoardState, "Running" | "NotPlanned">;
  open: boolean;
};

export type OeeBoard = {
  /** The whole shift window. */
  shift: Interval;
  /** The shift from its start to now (or to its end once it ended). */
  period: Interval;
  parts: OeeParts;
  ratios: OeeRatios;
  /** The OEE to show: Performance counts at most 100% (`shownOee`). */
  oee: number | null;
  /** The ideal time of the good pieces (the OEE numerator), in ms. */
  goodIdealMs: number;
  /**
   * The shift's time split, in ms: working = planned downtime + planned
   * time, and planned time = run + unplanned downtime.
   */
  times: {
    /** The shift time so far: planned downtime + planned time. */
    workingMs: number;
    /** Working time taken by a Planned stop (a Planned maintenance dispatch) that did not run. */
    plannedDowntimeMs: number;
    /** Planned time the machine did not run: the Availability loss. */
    unplannedDowntimeMs: number;
  };
  states: (Interval & { state: OeeBoardState })[];
  /** The state at the end of the period and when it began. */
  current: { state: OeeBoardState; since: number } | null;
  /** The stretch each operation held the work center, in order. */
  jobSpans: (Interval & { jobOperationId: string })[];
  /** Each operation of the shift, in the order it first ran. */
  jobs: OeeBoardJob[];
  hourly: OeeBoardHour[];
  /** The biggest losses first, at most 6, none of 0. */
  losses: { key: OeeLossKey; ms: number }[];
  /** The latest stops first, at most 5, of 2 minutes or more. */
  stops: OeeBoardStop[];
  /** Bad pieces by scrap reason (null: no reason), the most first. */
  scrap: { scrapReasonId: string | null; quantity: number }[];
  kpis: {
    /** Run seconds per piece made. */
    actualSecondsPerPiece: number | null;
    /** The ideal seconds per piece, weighted by the pieces made. */
    idealSecondsPerPiece: number | null;
    piecesPerHour: number | null;
    scrapRate: number | null;
    standardCoverage: number | null;
  };
};

export function buildOeeBoard(args: {
  input: Omit<OeeWorkCenterInput, "period">;
  stateSegments: OeeStateSegment[];
  shift: Interval;
  now: number;
  /**
   * The shift windows before the Planned stops come off. Without them the
   * planned windows are the working time, so there is no planned downtime.
   */
  workingWindows?: Interval[];
}): OeeBoard {
  const { input, shift, now } = args;
  const period: Interval = {
    start: shift.start,
    end: Math.max(shift.start, Math.min(shift.end, now))
  };
  const parts = computeOeeParts({ ...input, period });
  const ratios = oeeRatios(parts);

  // Scrap ideal: a manual Scrap on a Pulse work center has no total, so the
  // bad pieces are weighed on their own and capped at the ideal time made.
  let badIdealMs = 0;
  const scrapByReason = new Map<string | null, number>();
  for (const count of input.counts) {
    if (count.at < period.start || count.at >= period.end) continue;
    if (count.bad <= 0) continue;
    const ideal = countIdealSeconds(input, count);
    if (ideal !== null) badIdealMs += ideal * count.bad * 1000;
    const reason = count.scrapReasonId ?? null;
    scrapByReason.set(reason, (scrapByReason.get(reason) ?? 0) + count.bad);
  }
  const goodIdealMs = Math.max(
    0,
    parts.idealMs - Math.min(badIdealMs, parts.idealMs)
  );

  // Run inside a Planned stop is planned time already ("Run outside
  // shifts"), so it is not planned downtime as well.
  const plannedDowntimeMs = intervalLength(
    subtractWindows(
      subtractWindows(
        clipIntervals(args.workingWindows ?? input.plannedWindows, period),
        input.plannedWindows
      ),
      input.runIntervals
    )
  );
  const times = {
    workingMs: parts.plannedMs + plannedDowntimeMs,
    plannedDowntimeMs,
    unplannedDowntimeMs: Math.max(0, parts.plannedMs - parts.runMs)
  };

  const states = boardStates({
    period,
    plannedWindows: input.plannedWindows,
    runIntervals: input.runIntervals,
    stateSegments: args.stateSegments
  });
  const lastState = states[states.length - 1];
  const current =
    lastState && lastState.end === period.end
      ? { state: lastState.state, since: lastState.start }
      : null;

  const jobSpans = spansOfOwners(input.owners, period);
  const jobs = jobsOfSpans(input, jobSpans);

  const hourly: OeeBoardHour[] = [];
  for (
    let start = shift.start;
    start < shift.end && hourly.length < MAX_HOURS;
    start += HOUR_MS
  ) {
    const end = Math.min(start + HOUR_MS, shift.end);
    const isFuture = start >= period.end;
    const hourParts = isFuture
      ? EMPTY_OEE_PARTS
      : computeOeeParts({
          ...input,
          period: { start, end: Math.min(end, period.end) }
        });
    hourly.push({
      start,
      end,
      plannedMs: hourParts.plannedMs,
      idealMs: hourParts.idealMs,
      efficiency:
        hourParts.plannedMs > 0
          ? hourParts.idealMs / hourParts.plannedMs
          : null,
      isCurrent: start <= now && now < end && period.end === now,
      isFuture,
      jobChange: jobSpans.some(
        (span, index) => index > 0 && span.start >= start && span.start < end
      )
    });
  }

  const stateMs = (state: OeeBoardState) =>
    intervalLength(states.filter((segment) => segment.state === state));
  const losses = (
    [
      { key: "Down", ms: stateMs("Down") },
      { key: "Idle", ms: stateMs("Idle") },
      { key: "Offline", ms: stateMs("Offline") },
      { key: "Unknown", ms: stateMs("Unknown") },
      {
        key: "Speed",
        ms: Math.max(0, parts.runWithStandardMs - parts.idealMs)
      },
      { key: "Scrap", ms: parts.idealMs - goodIdealMs }
    ] satisfies { key: OeeLossKey; ms: number }[]
  )
    .filter((loss) => loss.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, LOSS_LIST_SIZE);

  const stops: OeeBoardStop[] = [];
  for (let index = states.length - 1; index >= 0; index--) {
    const segment = states[index]!;
    if (segment.state === "Running" || segment.state === "NotPlanned") continue;
    if (segment.end - segment.start < STOP_LOG_MIN_MS) continue;
    stops.push({
      start: segment.start,
      end: segment.end,
      state: segment.state,
      open: segment.end === period.end && period.end === now
    });
    if (stops.length === STOP_LOG_SIZE) break;
  }

  return {
    shift,
    period,
    parts,
    ratios,
    oee: shownOee(ratios),
    goodIdealMs,
    times,
    states,
    current,
    jobSpans,
    jobs,
    hourly,
    losses,
    stops,
    scrap: [...scrapByReason]
      .map(([scrapReasonId, quantity]) => ({ scrapReasonId, quantity }))
      .sort((a, b) => b.quantity - a.quantity),
    kpis: {
      actualSecondsPerPiece:
        parts.totalPieces > 0 ? parts.runMs / 1000 / parts.totalPieces : null,
      idealSecondsPerPiece:
        parts.totalPieces > 0 && parts.idealMs > 0
          ? parts.idealMs / 1000 / parts.totalPieces
          : null,
      piecesPerHour:
        parts.runMs > 0 ? (parts.totalPieces * HOUR_MS) / parts.runMs : null,
      scrapRate:
        parts.totalPieces > 0
          ? Math.min(parts.badPieces, parts.totalPieces) / parts.totalPieces
          : null,
      standardCoverage: ratios.standardCoverage
    }
  };
}

/**
 * The period split into one state per moment. Run time wins (it is planned
 * time, even outside the windows); then Down, Offline and Idle, in that
 * order, inside the planned windows; the planned time left is Unknown.
 */
export function boardStates(args: {
  period: Interval;
  plannedWindows: Interval[];
  runIntervals: Interval[];
  stateSegments: OeeStateSegment[];
}): (Interval & { state: OeeBoardState })[] {
  const { period } = args;
  if (period.end <= period.start) return [];
  const running = clipIntervals(args.runIntervals, period);
  const planned = clipIntervals(args.plannedWindows, period);
  const plannedStops = subtractWindows(planned, running);

  const lists: { state: OeeBoardState; list: Interval[] }[] = [
    { state: "Running", list: running }
  ];
  let claimed: Interval[] = [];
  for (const state of ["Down", "Offline", "Idle"] as const) {
    const list = subtractWindows(
      intersectWindows(
        args.stateSegments.filter((segment) => segment.state === state),
        plannedStops
      ),
      claimed
    );
    claimed = unionIntervals([...claimed, ...list]);
    lists.push({ state, list });
  }
  lists.push({
    state: "Unknown",
    list: subtractWindows(plannedStops, claimed)
  });
  lists.push({
    state: "NotPlanned",
    list: subtractWindows(subtractWindows([period], planned), running)
  });

  const segments = lists
    .flatMap(({ state, list }) =>
      list.map((interval) => ({ ...interval, state }))
    )
    .sort((a, b) => a.start - b.start);
  // Touching segments of one state are one stretch.
  const merged: (Interval & { state: OeeBoardState })[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && last.state === segment.state && last.end >= segment.start) {
      last.end = Math.max(last.end, segment.end);
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

/**
 * The stretch each operation held the work center: from the start of its
 * first Machine event after the previous operation, until the next operation
 * took over. The first stretch begins with the period, so the setup before
 * the first run belongs to the operation that follows it.
 */
export function spansOfOwners(
  owners: OeeWorkCenterInput["owners"],
  period: Interval
): (Interval & { jobOperationId: string })[] {
  const sorted = owners
    .filter((owner) => owner.end > period.start && owner.start < period.end)
    .sort((a, b) => a.start - b.start);
  const spans: (Interval & { jobOperationId: string })[] = [];
  for (const owner of sorted) {
    const last = spans[spans.length - 1];
    if (last && last.jobOperationId === owner.jobOperationId) continue;
    const start = last ? Math.max(owner.start, period.start) : period.start;
    if (last) last.end = start;
    spans.push({
      start,
      end: period.end,
      jobOperationId: owner.jobOperationId
    });
  }
  return spans.filter((span) => span.end > span.start);
}

function jobsOfSpans(
  input: Omit<OeeWorkCenterInput, "period">,
  spans: (Interval & { jobOperationId: string })[]
): OeeBoardJob[] {
  const byOperation = new Map<string, OeeParts>();
  for (const span of spans) {
    // Only the counts of this operation, so a late post of another one does
    // not land on it.
    const parts = computeOeeParts({
      ...input,
      period: span,
      counts: input.counts.filter(
        (count) =>
          count.jobOperationId === null ||
          count.jobOperationId === span.jobOperationId
      )
    });
    const before = byOperation.get(span.jobOperationId);
    byOperation.set(
      span.jobOperationId,
      before ? addOeeParts(before, parts) : parts
    );
  }
  return [...byOperation].map(([jobOperationId, parts]) => {
    const ratios = oeeRatios(parts);
    return { jobOperationId, parts, ratios, oee: shownOee(ratios) };
  });
}

/**
 * When `workMs` of work started at `from` ends, counting only the working
 * windows. Null when the windows end first.
 */
export function estimateFinish(args: {
  from: number;
  workMs: number;
  windows: Interval[];
}): number | null {
  let left = args.workMs;
  if (left <= 0) return args.from;
  for (const window of unionIntervals(args.windows)) {
    if (window.end <= args.from) continue;
    const start = Math.max(window.start, args.from);
    const length = window.end - start;
    if (length >= left) return start + left;
    left -= length;
  }
  return null;
}
