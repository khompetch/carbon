// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

// Reads what the OEE calculator needs for a set of work centers, one read per
// table. The ERP page and the MES board both call it. Spec:
// .ai/specs/2026-11-14-oee-dashboard.md ("The calculation").

import {
  type Database,
  fetchAllByIds,
  fetchAllRecords
} from "@carbon/database";
import { fromAbsolute, toCalendarDate } from "@internationalized/date";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { toInstantMs } from "../scheduling/date-utils.ts";
import {
  getWorkCenterWorkingWindows,
  type ShiftRow
} from "../scheduling/work-center-windows.ts";
import {
  type Interval,
  runIntervalsFromStateChanges,
  subtractWindows,
  unionIntervals
} from "./intervals.ts";
import type { OeeCount, OeeOwner, OeeWorkCenterInput } from "./oee.ts";
import {
  deviceIdealSecondsPerPiece,
  idealSecondsPerPiece,
  type MachineUnit
} from "./standards.ts";

export type OeeLoadedWorkCenter = {
  workCenterId: string;
  alwaysOn: boolean;
  /** Sensor: a device reports the run time. Operator: Machine events do. */
  source: "Sensor" | "Operator";
  /** The shift windows with the holidays closed, before the Planned stops. */
  workingWindows: Interval[];
  input: Omit<OeeWorkCenterInput, "period">;
};

/**
 * How far before the range the reader looks for the state a machine was in
 * when the range starts. A device's own current state covers a longer quiet
 * stretch.
 */
const STATE_LOOKBACK_MS = 7 * 24 * 3_600_000;
const SENSOR_NOTE = "Pulse sensor ";
const SHIFT_FIELDS =
  "id, locationId, startTime, endTime, monday, tuesday, wednesday, thursday, friday, saturday, sunday";

const iso = (ms: number) => fromAbsolute(ms, "UTC").toAbsoluteString();
const localDate = (ms: number, timeZone: string) =>
  toCalendarDate(fromAbsolute(ms, timeZone));

type ShiftWithLocation = ShiftRow & { id: string; locationId: string | null };

export async function loadOeeWorkCenters(
  client: SupabaseClient<Database>,
  args: {
    companyId: string;
    workCenterIds: string[];
    from: number;
    to: number;
    now: number;
    timeZone: string;
  }
): Promise<{ data: OeeLoadedWorkCenter[]; error: PostgrestError | null }> {
  const { companyId, workCenterIds, from, now, timeZone } = args;
  const to = Math.min(args.to, now);
  if (workCenterIds.length === 0 || to <= from) {
    return { data: [], error: null };
  }
  const fromIso = iso(from);
  const toIso = iso(to);
  const lookbackIso = iso(from - STATE_LOOKBACK_MS);

  const [
    workCenters,
    links,
    devices,
    stateChanges,
    machineEvents,
    plannedStops,
    holidays
  ] = await Promise.all([
    fetchAllByIds<{ id: string; alwaysOn: boolean; locationId: string | null }>(
      workCenterIds,
      (batch) =>
        client
          .from("workCenter")
          .select("id, alwaysOn, locationId")
          .eq("companyId", companyId)
          .in("id", batch)
          .order("id")
    ),
    fetchAllByIds<{ id: string; workCenterId: string; shiftId: string }>(
      workCenterIds,
      (batch) =>
        client
          .from("workCenterShift")
          .select("id, workCenterId, shiftId")
          .eq("companyId", companyId)
          .in("workCenterId", batch)
          .order("id")
    ),
    fetchAllByIds<{
      workCenterId: string;
      integration: string;
      externalDeviceId: string;
      currentState: string | null;
      currentStateAt: string | null;
    }>(workCenterIds, (batch) =>
      client
        .from("workCenterDevice")
        .select(
          "workCenterId, integration, externalDeviceId, currentState, currentStateAt"
        )
        .eq("companyId", companyId)
        .in("workCenterId", batch)
        .order("workCenterId")
    ),
    fetchAllByIds<{
      id: string;
      workCenterId: string;
      changedAt: string;
      state: string;
    }>(workCenterIds, (batch) =>
      client
        .from("machineStateChange")
        .select("id, workCenterId, changedAt, state")
        .eq("companyId", companyId)
        .in("workCenterId", batch)
        .gte("changedAt", lookbackIso)
        .lt("changedAt", toIso)
        .order("id")
    ),
    fetchAllByIds<{
      id: string;
      workCenterId: string | null;
      jobOperationId: string;
      startTime: string;
      endTime: string | null;
    }>(workCenterIds, (batch) =>
      client
        .from("productionEvent")
        .select("id, workCenterId, jobOperationId, startTime, endTime")
        .eq("companyId", companyId)
        .eq("type", "Machine")
        .in("workCenterId", batch)
        .lt("startTime", toIso)
        .or(`endTime.is.null,endTime.gt.${fromIso}`)
        .order("id")
    ),
    fetchAllByIds<{
      id: string;
      workCenterId: string | null;
      status: string;
      actualStartTime: string | null;
      actualEndTime: string | null;
      completedAt: string | null;
      updatedAt: string | null;
      createdAt: string;
    }>(workCenterIds, (batch) =>
      client
        .from("maintenanceDispatch")
        .select(
          "id, workCenterId, status, actualStartTime, actualEndTime, completedAt, updatedAt, createdAt"
        )
        .eq("companyId", companyId)
        .eq("oeeImpact", "Planned")
        .in("workCenterId", batch)
        .not("actualStartTime", "is", null)
        .lt("actualStartTime", toIso)
        .or(`completedAt.is.null,completedAt.gt.${fromIso}`)
        .order("id")
    ),
    fetchAllRecords<{ id: string; date: string }>(() =>
      client
        .from("holiday")
        .select("id, date")
        .eq("companyId", companyId)
        .gte("date", localDate(from, timeZone).subtract({ days: 1 }).toString())
        .lte("date", localDate(to, timeZone).add({ days: 1 }).toString())
        .order("id")
    )
  ]);

  for (const read of [
    workCenters,
    links,
    devices,
    stateChanges,
    machineEvents,
    plannedStops,
    holidays
  ]) {
    if (read.error) return { data: [], error: read.error };
  }

  // Shifts: each location's own, and the linked shifts of another location.
  const locationIds = [
    ...new Set(
      (workCenters.data ?? []).flatMap((wc) =>
        wc.locationId ? [wc.locationId] : []
      )
    )
  ];
  const linkedShiftIds = [
    ...new Set((links.data ?? []).map((link) => link.shiftId))
  ];
  const [locationShifts, linkedShifts] = await Promise.all([
    fetchAllByIds<ShiftWithLocation>(locationIds, (batch) =>
      client
        .from("shift")
        .select(SHIFT_FIELDS)
        .eq("companyId", companyId)
        .eq("active", true)
        .in("locationId", batch)
        .order("id")
    ),
    fetchAllByIds<ShiftWithLocation>(linkedShiftIds, (batch) =>
      client
        .from("shift")
        .select(SHIFT_FIELDS)
        .eq("companyId", companyId)
        .eq("active", true)
        .in("id", batch)
        .order("id")
    )
  ]);
  if (locationShifts.error) return { data: [], error: locationShifts.error };
  if (linkedShifts.error) return { data: [], error: linkedShifts.error };

  // Counts: Pulse buckets for Pulse work centers, posted quantities for all.
  const pulseKeys = (devices.data ?? [])
    .filter((device) => device.integration === "pulse")
    .map((device) => device.externalDeviceId);
  const pulseDevices = await fetchAllByIds<{
    id: string;
    deviceKey: string;
    piecesPerPulse: number;
    expectedCycleSeconds: number | null;
  }>(pulseKeys, (batch) =>
    client
      .from("pulseDevice")
      .select("id, deviceKey, piecesPerPulse, expectedCycleSeconds")
      .eq("companyId", companyId)
      .in("deviceKey", batch)
      .order("id")
  );
  if (pulseDevices.error) return { data: [], error: pulseDevices.error };

  const [pulseCounts, quantities] = await Promise.all([
    fetchAllByIds<{
      id: string;
      pulseDeviceId: string;
      periodEnd: string;
      pulses: number;
      scrapPulses: number;
    }>(
      (pulseDevices.data ?? []).map((device) => device.id),
      (batch) =>
        client
          .from("pulseCount")
          .select("id, pulseDeviceId, periodEnd, pulses, scrapPulses")
          .eq("companyId", companyId)
          .in("pulseDeviceId", batch)
          .gte("periodEnd", fromIso)
          .lt("periodEnd", toIso)
          .order("id")
    ),
    fetchAllByIds<{
      id: string;
      jobOperationId: string;
      type: Database["public"]["Enums"]["productionQuantityType"];
      quantity: number;
      notes: string | null;
      createdAt: string;
      jobOperation: { workCenterId: string | null } | null;
    }>(workCenterIds, (batch) =>
      client
        .from("productionQuantity")
        .select(
          "id, jobOperationId, type, quantity, notes, createdAt, jobOperation!inner(workCenterId)"
        )
        .eq("companyId", companyId)
        .in("jobOperation.workCenterId", batch)
        .gte("createdAt", fromIso)
        .lt("createdAt", toIso)
        .order("id")
    )
  ]);
  if (pulseCounts.error) return { data: [], error: pulseCounts.error };
  if (quantities.error) return { data: [], error: quantities.error };

  // Standards of every operation that owns run time or holds a count.
  const operationIds = [
    ...new Set([
      ...(machineEvents.data ?? []).map((event) => event.jobOperationId),
      ...(quantities.data ?? []).map((row) => row.jobOperationId)
    ])
  ];
  const operations = await fetchAllByIds<{
    id: string;
    machineTime: number;
    machineUnit: MachineUnit;
  }>(operationIds, (batch) =>
    client
      .from("jobOperation")
      .select("id, machineTime, machineUnit")
      .eq("companyId", companyId)
      .in("id", batch)
      .order("id")
  );
  if (operations.error) return { data: [], error: operations.error };

  const idealByOperation = new Map(
    (operations.data ?? []).map((operation) => [
      operation.id,
      idealSecondsPerPiece(operation.machineTime, operation.machineUnit)
    ])
  );

  const workingWindows = workingWindowsByWorkCenter({
    workCenters: workCenters.data ?? [],
    links: links.data ?? [],
    locationShifts: locationShifts.data ?? [],
    linkedShifts: linkedShifts.data ?? [],
    holidayDates: new Set(
      (holidays.data ?? []).map((row) => row.date.slice(0, 10))
    ),
    timeZone,
    rangeStart: from,
    rangeEnd: to
  });

  const pulseDeviceByKey = new Map(
    (pulseDevices.data ?? []).map((device) => [device.deviceKey, device])
  );

  const data = (workCenters.data ?? []).map((workCenter) => {
    const id = workCenter.id;
    const device = (devices.data ?? []).find((row) => row.workCenterId === id);
    const pulse =
      device?.integration === "pulse"
        ? pulseDeviceByKey.get(device.externalDeviceId)
        : undefined;

    const changes = (stateChanges.data ?? [])
      .filter((row) => row.workCenterId === id)
      .map((row) => ({
        changedAt: toInstantMs(row.changedAt),
        state: row.state
      }));
    const source: OeeLoadedWorkCenter["source"] =
      device || changes.some((change) => change.changedAt >= from)
        ? "Sensor"
        : "Operator";

    const owners: OeeOwner[] = (machineEvents.data ?? [])
      .filter((event) => event.workCenterId === id)
      .map((event) => ({
        start: toInstantMs(event.startTime),
        end: event.endTime ? toInstantMs(event.endTime) : now,
        jobOperationId: event.jobOperationId
      }))
      .filter((owner) => owner.end > owner.start);

    let runIntervals: Interval[];
    if (source === "Sensor") {
      // With no change before the range in the lookback, the device's own
      // current state (set before the range) is the state at the start.
      const known = changes.some((change) => change.changedAt < from);
      const startState =
        !known &&
        device?.currentState &&
        device.currentStateAt &&
        toInstantMs(device.currentStateAt) < from
          ? [{ changedAt: from, state: device.currentState }]
          : [];
      runIntervals = runIntervalsFromStateChanges(
        [...startState, ...changes],
        to
      );
    } else {
      runIntervals = unionIntervals(owners);
    }

    const counts: OeeCount[] = [];
    const rows = (quantities.data ?? []).filter(
      (row) => row.jobOperation?.workCenterId === id
    );
    if (pulse) {
      for (const bucket of (pulseCounts.data ?? []).filter(
        (row) => row.pulseDeviceId === pulse.id
      )) {
        counts.push({
          at: toInstantMs(bucket.periodEnd),
          jobOperationId: null,
          total: bucket.pulses * pulse.piecesPerPulse,
          bad: bucket.scrapPulses * pulse.piecesPerPulse
        });
      }
      // The sensor's own rows are already in the buckets.
      for (const row of rows) {
        if (row.type === "Production") continue;
        if (row.notes?.startsWith(SENSOR_NOTE)) continue;
        counts.push({
          at: toInstantMs(row.createdAt),
          jobOperationId: row.jobOperationId,
          total: 0,
          bad: row.quantity
        });
      }
    } else {
      for (const row of rows) {
        counts.push({
          at: toInstantMs(row.createdAt),
          jobOperationId: row.jobOperationId,
          total: row.quantity,
          bad: row.type === "Production" ? 0 : row.quantity
        });
      }
    }

    const windows = workingWindows.get(id) ?? [];
    const stops = (plannedStops.data ?? [])
      .filter((stop) => stop.workCenterId === id && stop.actualStartTime)
      .map((stop) => ({
        start: toInstantMs(stop.actualStartTime!),
        end:
          stop.status === "In Progress"
            ? now
            : toInstantMs(
                stop.completedAt ??
                  stop.actualEndTime ??
                  stop.updatedAt ??
                  stop.createdAt
              )
      }));

    return {
      workCenterId: id,
      alwaysOn: workCenter.alwaysOn,
      source,
      workingWindows: windows,
      input: {
        plannedWindows: subtractWindows(windows, stops),
        runIntervals,
        owners,
        idealByOperation,
        deviceIdealSeconds: pulse
          ? deviceIdealSecondsPerPiece(
              pulse.expectedCycleSeconds,
              pulse.piecesPerPulse
            )
          : null,
        counts
      }
    };
  });

  return { data, error: null };
}

/** The working windows of each work center, location by location. */
function workingWindowsByWorkCenter(args: {
  workCenters: { id: string; alwaysOn: boolean; locationId: string | null }[];
  links: { workCenterId: string; shiftId: string }[];
  locationShifts: ShiftWithLocation[];
  linkedShifts: ShiftWithLocation[];
  holidayDates: Set<string>;
  timeZone: string;
  rangeStart: number;
  rangeEnd: number;
}): Map<string, Interval[]> {
  const result = new Map<string, Interval[]>();
  const locations = new Set(args.workCenters.map((wc) => wc.locationId));
  for (const locationId of locations) {
    const workCenters = args.workCenters.filter(
      (wc) => wc.locationId === locationId
    );
    const ids = new Set(workCenters.map((wc) => wc.id));
    const windows = getWorkCenterWorkingWindows({
      workCenters,
      workCenterShifts: args.links.filter((link) => ids.has(link.workCenterId)),
      shifts: args.locationShifts.filter(
        (shift) => shift.locationId === locationId
      ),
      linkedShifts: args.linkedShifts.filter(
        (shift) => shift.locationId !== locationId
      ),
      timeZone: args.timeZone,
      holidayDates: args.holidayDates,
      rangeStart: args.rangeStart,
      rangeEnd: args.rangeEnd
    });
    for (const [workCenterId, list] of windows) {
      result.set(workCenterId, list);
    }
  }
  return result;
}
