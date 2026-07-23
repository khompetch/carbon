/**
 * Pure per-shift, per-hour OEE math shared by the ERP and MES work-center
 * OEE boards. Callers fetch the rows with their own Supabase client and pass
 * absolute epoch-ms timestamps; nothing here touches the network or the DB.
 *
 * Definitions (mirroring the aggregate OEE dashboard, api+/production.oee.ts):
 * - PDT  = merged Planned downtime (recorded workCenterDowntime rows typed
 *          Planned + maintenance dispatch windows) clamped to the bucket
 * - runtime = merged production event intervals clamped to the bucket
 * - UPDT = elapsed bucket time − PDT − runtime (unrecorded idle gaps count)
 * - %A = runtime / (elapsed − PDT)
 * - earned = apportioned setup standard (while Setup events ran) +
 *            max(labor, machine) standard for pieces recorded in the bucket
 * - %P = earned / runtime
 * - %Q = good / (good + scrap + rework), bucketed by createdAt
 * - TARGET = (elapsed − PDT) / standard-ms-per-piece of the bucket's active op
 */

export type OeeIntervalInput = {
  /** ISO timestamp */
  startTime: string;
  /** ISO timestamp; null = still open (clamped to `now`) */
  endTime: string | null;
};

export type OeeEventInput = OeeIntervalInput & {
  type: "Setup" | "Labor" | "Machine" | null;
  jobOperationId: string;
};

export type OeeQuantityInput = {
  createdAt: string;
  type: "Production" | "Scrap" | "Rework";
  quantity: number;
  jobOperationId: string;
};

export type OeeStandardInput = {
  jobOperationId: string;
  setupTime: number | null;
  setupUnit: string | null;
  laborTime: number | null;
  laborUnit: string | null;
  machineTime: number | null;
  machineUnit: string | null;
};

export type OeeHourBucket = {
  /** epoch ms */
  start: number;
  /** epoch ms */
  end: number;
  /** ms of the bucket that has elapsed (0 for future buckets) */
  elapsedMs: number;
  pdtMs: number;
  updtMs: number;
  runtimeMs: number;
  earnedMs: number;
  good: number;
  defect: number;
  target: number;
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
};

export type OeeShiftTotals = {
  elapsedMs: number;
  pdtMs: number;
  updtMs: number;
  runtimeMs: number;
  earnedMs: number;
  good: number;
  defect: number;
  target: number;
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
};

export type ComputeShiftHourlyOeeInput = {
  /** shift window, epoch ms */
  shiftStart: number;
  shiftEnd: number;
  /** current time, epoch ms — open intervals clamp here */
  now: number;
  events: OeeEventInput[];
  quantities: OeeQuantityInput[];
  standards: OeeStandardInput[];
  /** recorded Planned downtime + planned maintenance windows */
  plannedDowntimes: OeeIntervalInput[];
  /** recorded Unplanned downtime windows — subtracted from runtime */
  unplannedDowntimes?: OeeIntervalInput[];
  /**
   * Auto no-output detection: when set and an open production event has had
   * no output for longer than multiplier × msPerPiece, the excess is treated
   * as a virtual unplanned downtime interval (live board view; the background
   * detector records the real row within a minute).
   */
  noOutput?: { msPerPiece: number; multiplier: number };
};

type Interval = [number, number];

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Fixed per-operation allowances — not a rate, excluded from rate math */
const TOTAL_UNITS = new Set(["Total Hours", "Total Minutes"]);

export function clampInterval(
  interval: Interval,
  windowStart: number,
  windowEnd: number
): Interval | null {
  const start = Math.max(interval[0], windowStart);
  const end = Math.min(interval[1], windowEnd);
  return end > start ? [start, end] : null;
}

/** Merge overlapping intervals and return total covered duration in ms */
export function mergedDuration(intervals: Interval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let currentStart = sorted[0]![0];
  let currentEnd = sorted[0]![1];
  for (let i = 1; i < sorted.length; i++) {
    const [start, end] = sorted[i]!;
    if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
    } else {
      total += currentEnd - currentStart;
      [currentStart, currentEnd] = [start, end];
    }
  }
  total += currentEnd - currentStart;
  return total;
}

/** Subtract `minus` intervals from `base` intervals (both may overlap) */
export function subtractIntervals(
  base: Interval[],
  minus: Interval[]
): Interval[] {
  if (base.length === 0 || minus.length === 0) return [...base];
  const sortedMinus = [...minus].sort((a, b) => a[0] - b[0]);
  const result: Interval[] = [];
  for (const interval of base) {
    let segments: Interval[] = [interval];
    for (const [minusStart, minusEnd] of sortedMinus) {
      const next: Interval[] = [];
      for (const [start, end] of segments) {
        if (minusEnd <= start || minusStart >= end) {
          next.push([start, end]);
          continue;
        }
        if (minusStart > start) next.push([start, minusStart]);
        if (minusEnd < end) next.push([minusEnd, end]);
      }
      segments = next;
      if (segments.length === 0) break;
    }
    result.push(...segments);
  }
  return result;
}

/**
 * Detect a "no output" condition: an open production event whose operation has
 * logged no quantity for longer than multiplier × msPerPiece. Returns the
 * epoch ms at which the threshold was crossed, or null.
 */
export function detectNoOutput(args: {
  events: OeeEventInput[];
  quantities: OeeQuantityInput[];
  msPerPiece: number;
  multiplier: number;
  now: number;
}): number | null {
  const { events, quantities, msPerPiece, multiplier, now } = args;
  if (msPerPiece <= 0 || multiplier <= 0) return null;

  // Setup events legitimately produce no output — they never start the clock
  const openEvents = events.filter(
    (event) => event.endTime === null && event.type !== "Setup"
  );
  if (openEvents.length === 0) return null;

  const openStart = Math.min(
    ...openEvents.map((event) => new Date(event.startTime).getTime())
  );
  if (Number.isNaN(openStart)) return null;

  const openOperationIds = new Set(
    openEvents.map((event) => event.jobOperationId)
  );
  let lastOutput = Number.NEGATIVE_INFINITY;
  for (const quantity of quantities) {
    if (!openOperationIds.has(quantity.jobOperationId)) continue;
    const time = new Date(quantity.createdAt).getTime();
    if (!Number.isNaN(time) && time > lastOutput) lastOutput = time;
  }

  const baseline = Math.max(openStart, lastOutput);
  const threshold = multiplier * msPerPiece;
  return now - baseline > threshold ? baseline + threshold : null;
}

/**
 * Convert a standard factor (time, unit) to milliseconds per piece.
 * Returns 0 for fixed allowances (Total Hours/Minutes) and unknown units.
 */
export function standardMsPerPiece(
  time: number | null | undefined,
  unit: string | null | undefined
): number {
  const t = Number(time ?? 0);
  if (!t || t <= 0 || !unit || TOTAL_UNITS.has(unit)) return 0;
  switch (unit) {
    case "Hours/Piece":
      return t * HOUR_MS;
    case "Hours/100 Pieces":
      return (t * HOUR_MS) / 100;
    case "Hours/1000 Pieces":
      return (t * HOUR_MS) / 1000;
    case "Minutes/Piece":
      return t * MINUTE_MS;
    case "Minutes/100 Pieces":
      return (t * MINUTE_MS) / 100;
    case "Minutes/1000 Pieces":
      return (t * MINUTE_MS) / 1000;
    case "Seconds/Piece":
      return t * 1000;
    case "Pieces/Hour":
      return HOUR_MS / t;
    case "Pieces/Minute":
      return MINUTE_MS / t;
    default:
      return 0;
  }
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function toInterval(row: OeeIntervalInput, now: number): Interval | null {
  const start = new Date(row.startTime).getTime();
  const end = row.endTime ? new Date(row.endTime).getTime() : now;
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return [start, end];
}

export function computeShiftHourlyOee(input: ComputeShiftHourlyOeeInput): {
  hours: OeeHourBucket[];
  totals: OeeShiftTotals;
} {
  const { shiftStart, shiftEnd, now } = input;

  const eventIntervals: { interval: Interval; event: OeeEventInput }[] = [];
  for (const event of input.events) {
    const interval = toInterval(event, now);
    if (interval) eventIntervals.push({ interval, event });
  }

  const plannedIntervals: Interval[] = [];
  for (const downtime of input.plannedDowntimes) {
    const interval = toInterval(downtime, now);
    if (interval) plannedIntervals.push(interval);
  }

  // All recorded downtime (plus the virtual no-output window) wins over
  // production events: it is subtracted from runtime so %A reflects reality
  // even when the operator left the event running.
  const downtimeIntervals: Interval[] = [...plannedIntervals];
  for (const downtime of input.unplannedDowntimes ?? []) {
    const interval = toInterval(downtime, now);
    if (interval) downtimeIntervals.push(interval);
  }
  if (input.noOutput) {
    const noOutputStart = detectNoOutput({
      events: input.events,
      quantities: input.quantities,
      msPerPiece: input.noOutput.msPerPiece,
      multiplier: input.noOutput.multiplier,
      now
    });
    if (noOutputStart !== null && noOutputStart < now) {
      downtimeIntervals.push([noOutputStart, now]);
    }
  }

  // Per-operation ms/piece: scheduling convention duration = max(labor, machine)
  const msPerPieceByOperation = new Map<string, number>();
  for (const standard of input.standards) {
    msPerPieceByOperation.set(
      standard.jobOperationId,
      Math.max(
        standardMsPerPiece(standard.laborTime, standard.laborUnit),
        standardMsPerPiece(standard.machineTime, standard.machineUnit)
      )
    );
  }

  const quantityTimes = input.quantities.map((quantity) => ({
    ...quantity,
    time: new Date(quantity.createdAt).getTime()
  }));

  const hours: OeeHourBucket[] = [];
  for (
    let bucketStart = shiftStart;
    bucketStart < shiftEnd;
    bucketStart += HOUR_MS
  ) {
    const bucketEnd = Math.min(bucketStart + HOUR_MS, shiftEnd);
    const elapsedEnd = Math.min(bucketEnd, now);
    const elapsedMs = Math.max(0, elapsedEnd - bucketStart);

    if (elapsedMs === 0) {
      hours.push({
        start: bucketStart,
        end: bucketEnd,
        elapsedMs: 0,
        pdtMs: 0,
        updtMs: 0,
        runtimeMs: 0,
        earnedMs: 0,
        good: 0,
        defect: 0,
        target: 0,
        availability: null,
        performance: null,
        quality: null,
        oee: null
      });
      continue;
    }

    const pdtMs = Math.min(
      elapsedMs,
      mergedDuration(
        plannedIntervals
          .map((interval) => clampInterval(interval, bucketStart, elapsedEnd))
          .filter((interval): interval is Interval => interval !== null)
      )
    );

    const bucketEvents = eventIntervals
      .map(({ interval, event }) => {
        const clamped = clampInterval(interval, bucketStart, elapsedEnd);
        return clamped ? { interval: clamped, event } : null;
      })
      .filter(
        (entry): entry is { interval: Interval; event: OeeEventInput } =>
          entry !== null
      );

    const runtimeMs = Math.min(
      elapsedMs,
      mergedDuration(
        subtractIntervals(
          bucketEvents.map((entry) => entry.interval),
          downtimeIntervals
        )
      )
    );

    // Pieces recorded in this bucket
    let good = 0;
    let defect = 0;
    const piecesByOperation = new Map<string, number>();
    for (const quantity of quantityTimes) {
      if (quantity.time < bucketStart || quantity.time >= elapsedEnd) continue;
      if (quantity.type === "Production") {
        good += quantity.quantity;
        piecesByOperation.set(
          quantity.jobOperationId,
          (piecesByOperation.get(quantity.jobOperationId) ?? 0) +
            quantity.quantity
        );
      } else {
        defect += quantity.quantity;
      }
    }

    // Earned standard time: pieces × ms/piece only (textbook OEE performance).
    // No setup credit — combined with downtime-subtracted runtime it inflated
    // %P far above 100%; setup shows up as availability loss instead.
    let earnedMs = 0;
    for (const [operationId, pieces] of piecesByOperation) {
      earnedMs += pieces * (msPerPieceByOperation.get(operationId) ?? 0);
    }

    // Target: pieces expected from the bucket's available time at the active
    // operation's standard rate. Active = the op with the most runtime in the
    // bucket; falls back to the op that recorded pieces here.
    const runtimeByOperation = new Map<string, number>();
    for (const { interval, event } of bucketEvents) {
      runtimeByOperation.set(
        event.jobOperationId,
        (runtimeByOperation.get(event.jobOperationId) ?? 0) +
          (interval[1] - interval[0])
      );
    }
    let activeOperationId: string | null = null;
    let activeRuntime = 0;
    for (const [operationId, ms] of runtimeByOperation) {
      if (ms > activeRuntime) {
        activeRuntime = ms;
        activeOperationId = operationId;
      }
    }
    if (!activeOperationId && piecesByOperation.size > 0) {
      activeOperationId = [...piecesByOperation.keys()][0] ?? null;
    }
    const msPerPiece = activeOperationId
      ? (msPerPieceByOperation.get(activeOperationId) ?? 0)
      : 0;
    const availableMs = Math.max(0, elapsedMs - pdtMs);
    const target = msPerPiece > 0 ? Math.round(availableMs / msPerPiece) : 0;

    const updtMs = Math.max(0, elapsedMs - pdtMs - runtimeMs);
    const availability = ratio(runtimeMs, availableMs);
    const performance = ratio(earnedMs, runtimeMs);
    const quality = ratio(good, good + defect);
    const oee =
      availability !== null && performance !== null && quality !== null
        ? availability * performance * quality
        : null;

    hours.push({
      start: bucketStart,
      end: bucketEnd,
      elapsedMs,
      pdtMs,
      updtMs,
      runtimeMs,
      earnedMs,
      good,
      defect,
      target,
      availability,
      performance,
      quality,
      oee
    });
  }

  const totals = hours.reduce(
    (accumulator, hour) => ({
      ...accumulator,
      elapsedMs: accumulator.elapsedMs + hour.elapsedMs,
      pdtMs: accumulator.pdtMs + hour.pdtMs,
      updtMs: accumulator.updtMs + hour.updtMs,
      runtimeMs: accumulator.runtimeMs + hour.runtimeMs,
      earnedMs: accumulator.earnedMs + hour.earnedMs,
      good: accumulator.good + hour.good,
      defect: accumulator.defect + hour.defect,
      target: accumulator.target + hour.target
    }),
    {
      elapsedMs: 0,
      pdtMs: 0,
      updtMs: 0,
      runtimeMs: 0,
      earnedMs: 0,
      good: 0,
      defect: 0,
      target: 0,
      availability: null as number | null,
      performance: null as number | null,
      quality: null as number | null,
      oee: null as number | null
    }
  );

  totals.availability = ratio(
    totals.runtimeMs,
    Math.max(0, totals.elapsedMs - totals.pdtMs)
  );
  totals.performance = ratio(totals.earnedMs, totals.runtimeMs);
  totals.quality = ratio(totals.good, totals.good + totals.defect);
  totals.oee =
    totals.availability !== null &&
    totals.performance !== null &&
    totals.quality !== null
      ? totals.availability * totals.performance * totals.quality
      : null;

  return { hours, totals };
}

// --- Shift window resolution ---------------------------------------------
// shift.startTime/endTime are TIME-of-day strings in the LOCATION's timezone;
// endTime <= startTime means the shift crosses midnight. Day-of-week flags
// apply to the shift's START date (resolved in the location timezone).

export type OeeShiftInput = {
  id: string;
  name?: string | null;
  /** HH:MM[:SS] wall time in the location timezone */
  startTime: string;
  endTime: string;
  sunday: boolean;
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
};

const DAY_FLAGS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
] as const;

/** TIME (HH:MM[:SS]) → milliseconds since midnight */
function timeToMs(time: string): number {
  const [h = 0, m = 0, s = 0] = time.split(":").map(Number);
  return ((h * 60 + m) * 60 + s) * 1000;
}

/** Offset of a timezone at a given instant (tz wall clock minus UTC), in ms */
function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    parts.hour === "24" ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUTC - date.getTime();
}

/** Epoch ms of a wall-clock time (dateStr YYYY-MM-DD + TIME) in a timezone */
export function wallTimeToEpoch(
  dateStr: string,
  time: string,
  timeZone: string
): number {
  const [y = 1970, m = 1, d = 1] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d) + timeToMs(time);
  return guess - tzOffsetMs(new Date(guess), timeZone);
}

/** Calendar date (YYYY-MM-DD) of an instant in a timezone */
export function dateInTimezone(instantMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(instantMs));
}

/**
 * The shift's absolute window for a given start date, or null when the shift
 * does not run that day. Overnight shifts (endTime <= startTime) end on the
 * following day.
 */
export function resolveShiftWindow(
  shift: OeeShiftInput,
  dateStr: string,
  timeZone: string
): { start: number; end: number } | null {
  const start = wallTimeToEpoch(dateStr, shift.startTime, timeZone);
  const weekday = new Date(
    start + tzOffsetMs(new Date(start), timeZone)
  ).getUTCDay();
  const dayFlag = DAY_FLAGS[weekday];
  if (!dayFlag || !shift[dayFlag]) return null;

  let durationMs = timeToMs(shift.endTime) - timeToMs(shift.startTime);
  if (durationMs <= 0) durationMs += 24 * HOUR_MS;
  return { start, end: start + durationMs };
}

/**
 * Find the shift whose window contains `now` (checking today and yesterday in
 * the location timezone, so overnight shifts resolve after midnight). Falls
 * back to the most recently ENDED window of the day — a between-shifts board
 * should show the shift that just finished, not nothing.
 */
export function findActiveShiftWindow(
  shifts: OeeShiftInput[],
  nowMs: number,
  timeZone: string
): { shift: OeeShiftInput; start: number; end: number } | null {
  const today = dateInTimezone(nowMs, timeZone);
  const yesterday = dateInTimezone(nowMs - 24 * HOUR_MS, timeZone);

  const candidates: { shift: OeeShiftInput; start: number; end: number }[] = [];
  for (const shift of shifts) {
    for (const dateStr of [yesterday, today]) {
      const window = resolveShiftWindow(shift, dateStr, timeZone);
      if (window) candidates.push({ shift, ...window });
    }
  }

  const active = candidates.find(
    (candidate) => candidate.start <= nowMs && nowMs < candidate.end
  );
  if (active) return active;

  const ended = candidates
    .filter((candidate) => candidate.end <= nowMs)
    .sort((a, b) => b.end - a.end);
  return ended[0] ?? null;
}
