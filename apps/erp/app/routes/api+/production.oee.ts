import { requirePermissions } from "@carbon/auth/auth.server";
import { fetchAllFromTable } from "@carbon/database";
import { subtractIntervals } from "@carbon/utils";
import {
  now,
  parseDateTime,
  toCalendarDateTime
} from "@internationalized/date";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LoaderFunctionArgs } from "react-router";
import { makeDurations } from "~/utils/duration";

// OEE = Availability × Performance × Quality, aggregated in TypeScript like
// the other production KPIs (see production.kpi.$key.ts). Tracking spec:
// .ai/specs/2026-07-09-oee-dashboard.md — semantics kept in sync with the
// hourly work-center board (.ai/specs/2026-07-16-oee-work-center-hourly.md).
//
//   Runtime      merged non-overlapping productionEvent intervals, clamped
//                to the requested range (open events clamped to now), MINUS
//                every recorded downtime interval on the event's work center
//                (downtime wins over a still-running event)
//   Planned      active location `shift` windows across the range (day-of-week
//                flags, weekday resolved in the location timezone) minus
//                PLANNED downtime: maintenance (oeeImpact Down/Planned) +
//                workCenterDowntime rows of type 'Planned'
//   Availability Runtime / Planned — recorded Unplanned downtime (incl. auto
//                no-output rows) lowers the numerator, not the denominator
//   Performance  earned standard time / Runtime, where earned = max(labor,
//                machine) standard for the pieces recorded in range
//                (makeDurations). No setup credit — setup counts as runtime
//                with zero earned, i.e. a Performance loss
//   Quality      Production / (Production + Scrap + Rework)
//
// Process view reuses the planned time of the distinct work centers where the
// process ran in range — an approximation, since only work centers have a
// calendar. Overall totals are always computed on the work-center basis.

const MS = 1000;
const DAY_MS = 24 * 60 * 60 * MS;

const WEEKDAY_FLAGS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
] as const;

type Interval = { start: number; end: number };

type OeeGroup = {
  id: string;
  name: string;
  runtimeMs: number;
  plannedMs: number;
  downtimeMs: number;
  earnedMs: number;
  good: number;
  scrap: number;
  rework: number;
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
};

function mergedDuration(intervals: Interval[]): number {
  const sorted = [...intervals].sort(
    (a, b) => a.start - b.start || a.end - b.end
  );
  let total = 0;
  let lastEnd: number | null = null;
  for (const { start, end } of sorted) {
    if (end <= start) continue;
    if (lastEnd === null || start > lastEnd) {
      total += end - start;
    } else if (end > lastEnd) {
      total += end - lastEnd;
    }
    if (lastEnd === null || end > lastEnd) lastEnd = end;
  }
  return total;
}

function clamp(
  startMs: number,
  endMs: number,
  windowStart: number,
  windowEnd: number
): Interval | null {
  const start = Math.max(startMs, windowStart);
  const end = Math.min(endMs, windowEnd);
  return end > start ? { start, end } : null;
}

/** TIME (HH:MM[:SS]) → milliseconds since midnight. */
function timeToMs(time: string): number {
  const [h = 0, m = 0, s = 0] = time.split(":").map(Number);
  return ((h * 60 + m) * 60 + s) * MS;
}

/** Offset of a timezone at a given instant (tz wall clock minus UTC), in ms. */
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
      .map((p) => [p.type, p.value])
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

/** Epoch ms of a wall-clock time (dateStr + TIME) in a timezone. */
function wallTimeToEpoch(
  dateStr: string,
  time: string,
  timeZone: string
): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d) + timeToMs(time);
  return guess - tzOffsetMs(new Date(guess), timeZone);
}

/** Calendar date (YYYY-MM-DD) of an instant in a timezone. */
function dateInTimezone(instantMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(instantMs));
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

const finite = (x: number) => (Number.isFinite(x) ? x : 0);

// Standards with a "Total" factor represent a fixed allowance per operation,
// not per piece — earn them only in periods where the operation produced
// output, so idle periods don't inflate Performance.
const TOTAL_UNITS = new Set(["Total Hours", "Total Minutes"]);

export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "production"
  });

  const url = new URL(request.url);
  const searchParams = new URLSearchParams(url.search);

  const start = String(searchParams.get("start"));
  const end = String(searchParams.get("end"));
  const groupBy =
    searchParams.get("groupBy") === "process" ? "process" : "workCenter";
  const locationId = searchParams.get("locationId") || null;

  const empty = {
    groups: [] as OeeGroup[],
    totals: null,
    previousTotals: null,
    scrapPareto: [] as { reason: string; quantity: number }[]
  };

  let startDate: ReturnType<typeof toCalendarDateTime>;
  let endDate: ReturnType<typeof toCalendarDateTime>;
  try {
    startDate = toCalendarDateTime(parseDateTime(start));
    endDate = toCalendarDateTime(parseDateTime(end));
  } catch {
    return empty;
  }
  const daysBetween = endDate.compare(startDate);
  if (daysBetween < 1 || daysBetween > 500) return empty;

  const previousEnd = startDate;
  const previousStart = startDate.add({ days: -daysBetween });
  const nowMs = new Date(toCalendarDateTime(now("UTC")).toString()).getTime();

  const [workCenters, processes, locations, shifts] = await Promise.all([
    client
      .from("workCenter")
      .select("id, name, locationId")
      .eq("companyId", companyId)
      .eq("active", true),
    client.from("process").select("id, name").eq("companyId", companyId),
    client.from("location").select("id, timezone").eq("companyId", companyId),
    client
      .from("shift")
      .select(
        "id, locationId, startTime, endTime, sunday, monday, tuesday, wednesday, thursday, friday, saturday"
      )
      .eq("companyId", companyId)
      .eq("active", true)
  ]);

  const workCenterById = new Map(
    (workCenters.data ?? [])
      .filter((wc) => !locationId || wc.locationId === locationId)
      .map((wc) => [wc.id, wc])
  );
  const processById = new Map((processes.data ?? []).map((p) => [p.id, p]));
  const timezoneByLocation = new Map(
    (locations.data ?? []).map((l) => [l.id, l.timezone])
  );

  async function computePeriod(periodStart: string, periodEnd: string) {
    const windowStart = new Date(periodStart).getTime();
    const windowEnd = Math.min(new Date(periodEnd).getTime(), nowMs);

    // The event/quantity tables grow one row per MES action — paginate past
    // PostgREST's 1000-row cap or a busy month silently truncates.
    const [events, quantities, dispatches, downtimes] = await Promise.all([
      fetchAllFromTable<{
        startTime: string;
        endTime: string | null;
        workCenterId: string | null;
        jobOperationId: string | null;
        type: string | null;
        processId: string | null;
        setupTime: number | null;
        setupUnit: string | null;
        laborTime: number | null;
        laborUnit: string | null;
        machineTime: number | null;
        machineUnit: string | null;
        operationQuantity: number | null;
      }>(
        client,
        "productionEvent",
        "startTime, endTime, workCenterId, jobOperationId, type, ...jobOperation(processId, setupTime, setupUnit, laborTime, laborUnit, machineTime, machineUnit, operationQuantity)",
        (query) =>
          query
            .eq("companyId", companyId)
            .gte("startTime", periodStart)
            .or(`endTime.lte.${periodEnd},endTime.is.null`)
            .order("startTime", { ascending: true })
      ),
      fetchAllFromTable<{
        type: string | null;
        quantity: number | null;
        jobOperationId: string | null;
        scrapReason: { name: string } | null;
        processId: string | null;
        workCenterId: string | null;
      }>(
        client,
        "productionQuantity",
        "type, quantity, jobOperationId, scrapReason(name), ...jobOperation(processId, workCenterId)",
        (query) =>
          query
            .eq("companyId", companyId)
            .gte("createdAt", periodStart)
            .lte("createdAt", periodEnd)
            .order("createdAt", { ascending: true })
      ),
      client
        .from("maintenanceDispatch")
        .select("workCenterId, actualStartTime, actualEndTime, oeeImpact")
        .eq("companyId", companyId)
        .in("oeeImpact", ["Down", "Planned"])
        .not("actualStartTime", "is", null)
        .lte("actualStartTime", periodEnd)
        .or(`actualEndTime.gte.${periodStart},actualEndTime.is.null`),
      // workCenterDowntime is newer than the generated DB types — cast until regen
      (client as SupabaseClient<any>)
        .from("workCenterDowntime")
        .select("workCenterId, type, startTime, endTime")
        .eq("companyId", companyId)
        .lt("startTime", periodEnd)
        .or(`endTime.is.null,endTime.gt.${periodStart}`) as unknown as Promise<{
        data:
          | {
              workCenterId: string;
              type: "Planned" | "Unplanned";
              startTime: string;
              endTime: string | null;
            }[]
          | null;
        error: any;
      }>
    ]);

    // ── Planned time per location (shift windows clamped to the window) ─────
    // Shift occurrences are materialized as absolute intervals in the
    // location's timezone and clamped to the same [windowStart, windowEnd]
    // the runtime uses — a partially elapsed day contributes only its elapsed
    // shift time. Overlapping shifts are merged, not double-counted.
    const plannedByLocation = new Map<string, number>();
    for (const [locId, timezone] of timezoneByLocation) {
      const locationShifts = (shifts.data ?? []).filter(
        (s) => s.locationId === locId
      );
      if (locationShifts.length === 0) {
        plannedByLocation.set(locId, 0);
        continue;
      }
      const intervals: Interval[] = [];
      const seenDates = new Set<string>();
      // Pad a day on each side so overnight shifts spilling into the window
      // are included regardless of timezone offset.
      for (let t = windowStart - DAY_MS; t <= windowEnd + DAY_MS; t += DAY_MS) {
        const dateStr = dateInTimezone(t, timezone);
        if (seenDates.has(dateStr)) continue;
        seenDates.add(dateStr);
        // dateStr is already the tz-local calendar date, so its weekday is
        // purely calendrical.
        const flag =
          WEEKDAY_FLAGS[new Date(`${dateStr}T12:00:00Z`).getUTCDay()];
        for (const s of locationShifts) {
          if (!s[flag]) continue;
          const startAbs = wallTimeToEpoch(dateStr, s.startTime, timezone);
          let duration = timeToMs(s.endTime) - timeToMs(s.startTime);
          if (duration <= 0) duration += DAY_MS; // overnight shift
          const clamped = clamp(
            startAbs,
            startAbs + duration,
            windowStart,
            windowEnd
          );
          if (clamped) intervals.push(clamped);
        }
      }
      plannedByLocation.set(locId, mergedDuration(intervals));
    }

    // ── Downtime per work center ─────────────────────────────────────────────
    // Planned downtime (maintenance + recorded Planned intervals) reduces the
    // availability denominator; Unplanned records (incl. auto no-output rows)
    // reduce runtime instead. ALL downtime is subtracted from runtime —
    // downtime wins over a still-running production event.
    const plannedDowntimeIntervals = new Map<string, Interval[]>();
    const unplannedDowntimeIntervals = new Map<string, Interval[]>();
    const pushDowntime = (
      map: Map<string, Interval[]>,
      workCenterId: string,
      interval: Interval
    ) => {
      const list = map.get(workCenterId) ?? [];
      list.push(interval);
      map.set(workCenterId, list);
    };

    for (const d of dispatches.data ?? []) {
      if (!d.workCenterId || !d.actualStartTime) continue;
      const interval = clamp(
        new Date(d.actualStartTime).getTime(),
        d.actualEndTime ? new Date(d.actualEndTime).getTime() : nowMs,
        windowStart,
        windowEnd
      );
      if (!interval) continue;
      pushDowntime(plannedDowntimeIntervals, d.workCenterId, interval);
    }
    for (const d of downtimes.data ?? []) {
      if (!d.workCenterId) continue;
      const interval = clamp(
        new Date(d.startTime).getTime(),
        d.endTime ? new Date(d.endTime).getTime() : nowMs,
        windowStart,
        windowEnd
      );
      if (!interval) continue;
      pushDowntime(
        d.type === "Planned"
          ? plannedDowntimeIntervals
          : unplannedDowntimeIntervals,
        d.workCenterId,
        interval
      );
    }

    const plannedDowntimeByWorkCenter = new Map<string, number>();
    for (const [wcId, intervals] of plannedDowntimeIntervals) {
      plannedDowntimeByWorkCenter.set(wcId, mergedDuration(intervals));
    }
    // All downtime (planned + unplanned) as tuples, for runtime subtraction
    // and the per-group downtime display
    const downtimeTuplesByWorkCenter = new Map<string, [number, number][]>();
    const downtimeByWorkCenter = new Map<string, number>();
    for (const wcId of new Set([
      ...plannedDowntimeIntervals.keys(),
      ...unplannedDowntimeIntervals.keys()
    ])) {
      const all = [
        ...(plannedDowntimeIntervals.get(wcId) ?? []),
        ...(unplannedDowntimeIntervals.get(wcId) ?? [])
      ];
      downtimeTuplesByWorkCenter.set(
        wcId,
        all.map(({ start, end }) => [start, end] as [number, number])
      );
      downtimeByWorkCenter.set(wcId, mergedDuration(all));
    }

    const plannedForWorkCenter = (wcId: string) => {
      const wc = workCenterById.get(wcId);
      if (!wc?.locationId) return 0;
      const planned = plannedByLocation.get(wc.locationId) ?? 0;
      return Math.max(
        0,
        planned - (plannedDowntimeByWorkCenter.get(wcId) ?? 0)
      );
    };

    // ── Runtime intervals + earned standard time ────────────────────────────
    type EventRow = NonNullable<typeof events.data>[number];
    const runtimeIntervals = new Map<string, Interval[]>(); // by group id
    const workCentersByGroup = new Map<string, Set<string>>();
    // Earned standard is per operation: pieces recorded in range × per-piece
    // standard. No setup credit — see the header comment.
    const operations = new Map<
      string,
      {
        event: EventRow;
        groupId: string | null;
        workCenterId: string;
      }
    >();

    const groupIdOf = (row: {
      workCenterId: string | null;
      processId?: string | null;
    }) => (groupBy === "process" ? (row.processId ?? null) : row.workCenterId);

    for (const event of events.data ?? []) {
      if (!event.workCenterId || !workCenterById.has(event.workCenterId))
        continue;
      const groupId = groupIdOf(event);
      if (!groupId) continue;

      const interval = clamp(
        new Date(event.startTime).getTime(),
        event.endTime ? new Date(event.endTime).getTime() : nowMs,
        windowStart,
        windowEnd
      );
      if (interval) {
        // Downtime wins: recorded downtime on this event's work center is
        // carved out of the event's runtime
        const minus = downtimeTuplesByWorkCenter.get(event.workCenterId);
        const segments = minus?.length
          ? subtractIntervals([[interval.start, interval.end]], minus).map(
              ([start, end]) => ({ start, end })
            )
          : [interval];
        if (segments.length > 0) {
          const list = runtimeIntervals.get(groupId) ?? [];
          list.push(...segments);
          runtimeIntervals.set(groupId, list);
        }
      }

      const wcs = workCentersByGroup.get(groupId) ?? new Set<string>();
      wcs.add(event.workCenterId);
      workCentersByGroup.set(groupId, wcs);

      if (event.jobOperationId) {
        const op = operations.get(event.jobOperationId) ?? {
          event,
          groupId,
          workCenterId: event.workCenterId
        };
        operations.set(event.jobOperationId, op);
      }
    }

    // ── Quantities per group + per operation ────────────────────────────────
    const quantityByGroup = new Map<
      string,
      { good: number; scrap: number; rework: number }
    >();
    const piecesByOperation = new Map<string, number>();
    const scrapByReason = new Map<string, number>();

    for (const q of quantities.data ?? []) {
      // Prefer the identity of the events this operation actually ran on —
      // productionEvent.workCenterId is the work center chosen at start,
      // while jobOperation.workCenterId is the (nullable) assignment and can
      // differ. Falling back to the assignment covers quantities recorded
      // without an in-range event.
      const opInfo = q.jobOperationId
        ? operations.get(q.jobOperationId)
        : undefined;
      const workCenterId = opInfo?.workCenterId ?? q.workCenterId;
      if (!workCenterId || !workCenterById.has(workCenterId)) continue;
      const qty = Number(q.quantity ?? 0);
      if (qty <= 0) continue;

      if (q.jobOperationId) {
        piecesByOperation.set(
          q.jobOperationId,
          (piecesByOperation.get(q.jobOperationId) ?? 0) + qty
        );
      }

      const groupId =
        opInfo?.groupId ?? groupIdOf({ workCenterId, processId: q.processId });
      if (groupId) {
        const bucket = quantityByGroup.get(groupId) ?? {
          good: 0,
          scrap: 0,
          rework: 0
        };
        if (q.type === "Production") bucket.good += qty;
        else if (q.type === "Scrap") bucket.scrap += qty;
        else if (q.type === "Rework") bucket.rework += qty;
        quantityByGroup.set(groupId, bucket);
      }

      if (q.type === "Scrap") {
        const reason = q.scrapReason?.name ?? "Unknown";
        scrapByReason.set(reason, (scrapByReason.get(reason) ?? 0) + qty);
      }
    }

    const earnedByGroup = new Map<string, number>();
    for (const [operationId, { event, groupId }] of operations) {
      if (!groupId) continue;
      const pieces = piecesByOperation.get(operationId) ?? 0;
      const durations = makeDurations({
        setupTime: event.setupTime ?? undefined,
        setupUnit: event.setupUnit ?? undefined,
        laborTime: event.laborTime ?? undefined,
        laborUnit: event.laborUnit ?? undefined,
        machineTime: event.machineTime ?? undefined,
        machineUnit: event.machineUnit ?? undefined,
        operationQuantity: pieces
      });
      // "Total" standards are a fixed per-operation allowance that
      // makeDurations returns regardless of quantity — earn them only when
      // the period produced output. Guard Infinity/NaN from Pieces/Hour-style
      // factors with zero time.
      const laborEarned =
        TOTAL_UNITS.has(event.laborUnit ?? "") && pieces === 0
          ? 0
          : finite(durations.laborDuration);
      const machineEarned =
        TOTAL_UNITS.has(event.machineUnit ?? "") && pieces === 0
          ? 0
          : finite(durations.machineDuration);
      const earned = Math.max(laborEarned, machineEarned);
      earnedByGroup.set(groupId, (earnedByGroup.get(groupId) ?? 0) + earned);
    }

    // ── Assemble groups ──────────────────────────────────────────────────────
    const groupIds = new Set<string>([
      ...runtimeIntervals.keys(),
      ...quantityByGroup.keys()
    ]);

    const groups: OeeGroup[] = [];
    for (const groupId of groupIds) {
      const name =
        groupBy === "process"
          ? (processById.get(groupId)?.name ?? groupId)
          : (workCenterById.get(groupId)?.name ?? groupId);

      const runtimeMs = mergedDuration(runtimeIntervals.get(groupId) ?? []);
      const wcs =
        groupBy === "process"
          ? [...(workCentersByGroup.get(groupId) ?? [])]
          : [groupId];
      const plannedMs = wcs.reduce(
        (sum, wcId) => sum + plannedForWorkCenter(wcId),
        0
      );
      const downtimeMs = wcs.reduce(
        (sum, wcId) => sum + (downtimeByWorkCenter.get(wcId) ?? 0),
        0
      );
      const earnedMs = earnedByGroup.get(groupId) ?? 0;
      const { good, scrap, rework } = quantityByGroup.get(groupId) ?? {
        good: 0,
        scrap: 0,
        rework: 0
      };

      const availability = ratio(runtimeMs, plannedMs);
      const performance = ratio(earnedMs, runtimeMs);
      const quality = ratio(good, good + scrap + rework);
      const oee =
        availability !== null && performance !== null && quality !== null
          ? availability * performance * quality
          : null;

      groups.push({
        id: groupId,
        name,
        runtimeMs,
        plannedMs,
        downtimeMs,
        earnedMs,
        good,
        scrap,
        rework,
        availability,
        performance,
        quality,
        oee
      });
    }
    groups.sort((a, b) => (b.oee ?? -1) - (a.oee ?? -1));

    // ── Overall totals (always on the work-center basis) ─────────────────────
    const totalRuntime = [...runtimeIntervals.values()].reduce(
      (sum, intervals) => sum + mergedDuration(intervals),
      0
    );
    const activeWorkCenters = new Set<string>();
    for (const wcs of workCentersByGroup.values()) {
      for (const wc of wcs) activeWorkCenters.add(wc);
    }
    const totalPlanned = [...activeWorkCenters].reduce(
      (sum, wcId) => sum + plannedForWorkCenter(wcId),
      0
    );
    const totalEarned = [...earnedByGroup.values()].reduce((a, b) => a + b, 0);
    let totalGood = 0;
    let totalScrap = 0;
    let totalRework = 0;
    for (const q of quantityByGroup.values()) {
      totalGood += q.good;
      totalScrap += q.scrap;
      totalRework += q.rework;
    }

    const availability = ratio(totalRuntime, totalPlanned);
    const performance = ratio(totalEarned, totalRuntime);
    const quality = ratio(totalGood, totalGood + totalScrap + totalRework);
    const totals = {
      runtimeMs: totalRuntime,
      plannedMs: totalPlanned,
      earnedMs: totalEarned,
      good: totalGood,
      scrap: totalScrap,
      rework: totalRework,
      availability,
      performance,
      quality,
      oee:
        availability !== null && performance !== null && quality !== null
          ? availability * performance * quality
          : null
    };

    const scrapPareto = [...scrapByReason.entries()]
      .map(([reason, quantity]) => ({ reason, quantity }))
      .sort((a, b) => b.quantity - a.quantity);

    return { groups, totals, scrapPareto };
  }

  const [current, previous] = await Promise.all([
    computePeriod(startDate.toString(), endDate.toString()),
    computePeriod(previousStart.toString(), previousEnd.toString())
  ]);

  return {
    groups: current.groups,
    totals: current.totals,
    previousTotals: previous.totals,
    scrapPareto: current.scrapPareto
  };
}
