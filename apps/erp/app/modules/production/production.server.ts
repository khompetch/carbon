import { ASSEMBLER_SERVICE_URL } from "@carbon/env";
import { trigger } from "@carbon/jobs";
import { isInternalEmail } from "@carbon/utils";
import { redirect } from "react-router";
import { path } from "~/utils/path";

// The geometry (assembler) service backs model conversion and motion planning.
// When it's unreachable those actions can't run, so loaders probe its health and
// the UI soft-gates the assembler-dependent controls. Result cached briefly so a
// navigation burst doesn't fan out one probe per route.
const ASSEMBLER_HEALTH_TTL_MS = 15_000;
const ASSEMBLER_HEALTH_TIMEOUT_MS = 2_000;
let assemblerHealthCache: { healthy: boolean; expires: number } | null = null;

export async function isAssemblerServiceHealthy(): Promise<boolean> {
  if (!ASSEMBLER_SERVICE_URL) return false;

  const now = Date.now();
  if (assemblerHealthCache && assemblerHealthCache.expires > now) {
    return assemblerHealthCache.healthy;
  }

  let healthy = false;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    ASSEMBLER_HEALTH_TIMEOUT_MS
  );
  try {
    const response = await fetch(`${ASSEMBLER_SERVICE_URL}/health`, {
      method: "GET",
      signal: controller.signal
    });
    healthy = response.ok;
  } catch {
    healthy = false;
  } finally {
    clearTimeout(timeout);
  }

  assemblerHealthCache = {
    healthy,
    expires: now + ASSEMBLER_HEALTH_TTL_MS
  };
  return healthy;
}

/**
 * Assemblies (animated work instructions) are internal-only while the module
 * matures. Mirrors the backups gate in settings.
 */
export function requireAssembliesInternal(email: string | null) {
  if (!isInternalEmail(email)) {
    throw redirect(path.to.production);
  }
}

/**
 * Triggers a job scheduling task via inngest.
 * Supports both initial scheduling and rescheduling.
 */
export async function triggerJobSchedule(
  jobId: string,
  companyId: string,
  userId: string,
  mode: "initial" | "reschedule" = "reschedule",
  direction: "backward" | "forward" = "backward"
) {
  const result = await trigger("schedule-job", {
    jobId,
    companyId,
    userId,
    mode,
    direction
  });

  return { success: true, runId: result.ids[0] };
}

/**
 * @deprecated Use triggerJobSchedule with mode="reschedule" instead.
 */
export async function triggerJobReschedule(
  jobId: string,
  companyId: string,
  userId: string
) {
  return triggerJobSchedule(jobId, companyId, userId, "reschedule", "backward");
}

// --- Work center hourly OEE (TV board) -----------------------------------

import type { Database } from "@carbon/database";
import type {
  OeeEventInput,
  OeeQuantityInput,
  OeeShiftInput,
  OeeStandardInput
} from "@carbon/utils";
import {
  computeShiftHourlyOee,
  detectNoOutput,
  findActiveShiftWindow,
  resolveShiftWindow,
  standardMsPerPiece
} from "@carbon/utils";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getWorkCenterDowntimes } from "./production.service";

export type WorkCenterOeeStatus =
  | "running"
  | "planned-downtime"
  | "unplanned-downtime"
  | "idle";

/**
 * Stable public share link for a work center's OEE TV board: one externalLink
 * row per work center (documentType 'WorkCenter'), created on first request
 * and reused forever after — the URL never changes. Call with the service role.
 */
export async function getOrCreateWorkCenterShareLink(
  serviceRole: SupabaseClient<Database>,
  args: { workCenterId: string; companyId: string }
) {
  const existing = await serviceRole
    .from("externalLink")
    .select("id")
    .eq("documentType", "WorkCenter")
    .eq("documentId", args.workCenterId)
    .eq("companyId", args.companyId)
    .maybeSingle();

  if (existing.data) {
    return { data: existing.data, error: null };
  }

  return serviceRole
    .from("externalLink")
    .insert({
      documentType: "WorkCenter",
      documentId: args.workCenterId,
      companyId: args.companyId
    })
    .select("id")
    .single();
}

/**
 * Fetch + compute everything the work-center hourly OEE board needs. Shared
 * by the api resource route and the page loader.
 */
export async function getWorkCenterHourlyOee(
  client: SupabaseClient<Database>,
  args: {
    workCenterId: string;
    companyId: string;
    /** YYYY-MM-DD shift start date in the location timezone */
    date?: string | null;
    shiftId?: string | null;
    now?: number;
  }
) {
  const { workCenterId, companyId } = args;
  const now = args.now ?? Date.now();

  const workCenter = await client
    .from("workCenter")
    .select("id, name, locationId, autoDowntimeMultiplier")
    .eq("id", workCenterId)
    .eq("companyId", companyId)
    .single();

  if (workCenter.error || !workCenter.data) {
    return { error: "Work center not found" as const, data: null };
  }

  const [location, shifts, companySettings] = await Promise.all([
    client
      .from("location")
      .select("id, timezone")
      .eq("id", workCenter.data.locationId ?? "")
      .maybeSingle(),
    client
      .from("shift")
      .select(
        "id, name, startTime, endTime, sunday, monday, tuesday, wednesday, thursday, friday, saturday"
      )
      .eq("companyId", companyId)
      .eq("locationId", workCenter.data.locationId ?? "")
      .eq("active", true)
      .order("startTime"),
    client
      .from("companySettings")
      .select("autoDowntimeMultiplier")
      .eq("id", companyId)
      .maybeSingle()
  ]);

  const timezone = location.data?.timezone ?? "UTC";
  const shiftRows = (shifts.data ?? []) as (OeeShiftInput & {
    name: string;
  })[];

  if (shiftRows.length === 0) {
    return { error: "No active shifts for this location" as const, data: null };
  }

  // Resolve the shift window: explicit shift+date, or the active/most recent
  let resolved: {
    shift: OeeShiftInput & { name: string };
    start: number;
    end: number;
  } | null = null;
  if (args.shiftId && args.date) {
    const shift = shiftRows.find((row) => row.id === args.shiftId);
    if (shift) {
      const window = resolveShiftWindow(shift, args.date, timezone);
      if (window) resolved = { shift, ...window };
    }
  }
  if (!resolved) {
    resolved = findActiveShiftWindow(shiftRows, now, timezone) as {
      shift: OeeShiftInput & { name: string };
      start: number;
      end: number;
    } | null;
  }
  if (!resolved) {
    return { error: "No shift window found" as const, data: null };
  }

  const windowStartIso = new Date(resolved.start).toISOString();
  const windowEndIso = new Date(resolved.end).toISOString();

  const [events, quantities, downtimes, maintenance, activeOperations] =
    await Promise.all([
      client
        .from("productionEvent")
        .select(
          "startTime, endTime, type, jobOperationId, ...jobOperation(setupTime, setupUnit, laborTime, laborUnit, machineTime, machineUnit)"
        )
        .eq("companyId", companyId)
        .eq("workCenterId", workCenterId)
        .lt("startTime", windowEndIso)
        .or(`endTime.is.null,endTime.gt.${windowStartIso}`),
      client
        .from("productionQuantity")
        .select(
          "createdAt, type, quantity, jobOperationId, ...jobOperation(workCenterId)"
        )
        .eq("companyId", companyId)
        .gte("createdAt", windowStartIso)
        .lt("createdAt", windowEndIso),
      getWorkCenterDowntimes(client, {
        workCenterId,
        companyId,
        startTime: windowStartIso,
        endTime: windowEndIso
      }),
      client
        .from("maintenanceDispatch")
        .select("actualStartTime, actualEndTime")
        .eq("companyId", companyId)
        .eq("workCenterId", workCenterId)
        .in("oeeImpact", ["Down", "Planned"])
        .not("actualStartTime", "is", null)
        .lt("actualStartTime", windowEndIso)
        .or(`actualEndTime.is.null,actualEndTime.gt.${windowStartIso}`),
      client
        .from("jobOperation")
        .select(
          "id, description, status, operationQuantity, quantityComplete, laborTime, laborUnit, machineTime, machineUnit, job(jobId, item(readableId, name))"
        )
        .eq("companyId", companyId)
        .eq("workCenterId", workCenterId)
        .in("status", ["Ready", "In Progress", "Paused"])
        .order("priority")
        .limit(5)
    ]);

  const eventRows = (events.data ?? []) as unknown as (OeeEventInput &
    Omit<OeeStandardInput, "jobOperationId">)[];

  const standardsByOperation = new Map<string, OeeStandardInput>();
  for (const row of eventRows) {
    if (!standardsByOperation.has(row.jobOperationId)) {
      standardsByOperation.set(row.jobOperationId, {
        jobOperationId: row.jobOperationId,
        setupTime: row.setupTime ?? 0,
        setupUnit: row.setupUnit ?? null,
        laborTime: row.laborTime ?? 0,
        laborUnit: row.laborUnit ?? null,
        machineTime: row.machineTime ?? 0,
        machineUnit: row.machineUnit ?? null
      });
    }
  }

  const quantityRows = (
    (quantities.data ?? []) as unknown as (OeeQuantityInput & {
      workCenterId: string | null;
    })[]
  ).filter((row) => row.workCenterId === workCenterId);

  const downtimeRows = downtimes.data ?? [];
  const plannedDowntimes = [
    ...downtimeRows
      .filter((row) => row.type === "Planned")
      .map((row) => ({ startTime: row.startTime, endTime: row.endTime })),
    ...(
      (maintenance.data ?? []) as {
        actualStartTime: string | null;
        actualEndTime: string | null;
      }[]
    )
      .filter((row) => row.actualStartTime)
      .map((row) => ({
        startTime: row.actualStartTime!,
        endTime: row.actualEndTime
      }))
  ];

  const unplannedDowntimes = downtimeRows
    .filter((row) => row.type === "Unplanned")
    .map((row) => ({ startTime: row.startTime, endTime: row.endTime }));

  // Auto no-output detection: per-WC override ?? company default (≤0 = off);
  // cycle time from the fastest per-piece rate of any operation with an open event
  const effectiveMultiplier =
    workCenter.data.autoDowntimeMultiplier ??
    companySettings.data?.autoDowntimeMultiplier ??
    null;
  let noOutputMsPerPiece = 0;
  for (const row of eventRows) {
    if (row.endTime !== null) continue;
    // Setup events legitimately produce no output — they never start the clock
    if (row.type === "Setup") continue;
    const standard = standardsByOperation.get(row.jobOperationId);
    if (!standard) continue;
    noOutputMsPerPiece = Math.max(
      noOutputMsPerPiece,
      standardMsPerPiece(standard.laborTime, standard.laborUnit),
      standardMsPerPiece(standard.machineTime, standard.machineUnit)
    );
  }
  const noOutput =
    effectiveMultiplier !== null &&
    effectiveMultiplier > 0 &&
    noOutputMsPerPiece > 0
      ? { msPerPiece: noOutputMsPerPiece, multiplier: effectiveMultiplier }
      : undefined;

  const oeeEvents = eventRows.map((row) => ({
    startTime: row.startTime,
    endTime: row.endTime,
    type: row.type,
    jobOperationId: row.jobOperationId
  }));

  const { hours, totals } = computeShiftHourlyOee({
    shiftStart: resolved.start,
    shiftEnd: resolved.end,
    now,
    events: oeeEvents,
    quantities: quantityRows,
    standards: [...standardsByOperation.values()],
    plannedDowntimes,
    unplannedDowntimes,
    noOutput
  });

  const hasOpenEvent = eventRows.some((row) => row.endTime === null);
  const openDowntime = downtimeRows.find((row) => row.endTime === null);
  const noOutputSince = noOutput
    ? detectNoOutput({
        events: oeeEvents,
        quantities: quantityRows,
        ...noOutput,
        now
      })
    : null;
  const status: WorkCenterOeeStatus = openDowntime
    ? openDowntime.type === "Planned"
      ? "planned-downtime"
      : "unplanned-downtime"
    : noOutputSince !== null
      ? "unplanned-downtime"
      : hasOpenEvent
        ? "running"
        : "idle";

  const currentJobs = (
    (activeOperations.data ?? []) as unknown as {
      id: string;
      description: string | null;
      status: string;
      operationQuantity: number | null;
      quantityComplete: number | null;
      laborTime: number | null;
      laborUnit: string | null;
      machineTime: number | null;
      machineUnit: string | null;
      job: {
        jobId: string | null;
        item: { readableId: string | null; name: string | null } | null;
      } | null;
    }[]
  ).map((row) => {
    const jobCycleTimeMs = Math.max(
      standardMsPerPiece(row.laborTime, row.laborUnit),
      standardMsPerPiece(row.machineTime, row.machineUnit)
    );
    return {
      id: row.id,
      jobReadableId: row.job?.jobId ?? null,
      itemReadableId: row.job?.item?.readableId ?? null,
      itemName: row.job?.item?.name ?? null,
      description: row.description,
      status: row.status,
      quantityComplete: row.quantityComplete ?? 0,
      operationQuantity: row.operationQuantity ?? null,
      cycleTimeMs: jobCycleTimeMs > 0 ? jobCycleTimeMs : null
    };
  });

  // Board-level cycle time for visual check: the value the auto-downtime
  // detector actually compares against (running ops), or the fastest active
  // operation's standard when nothing is running
  const cycleTimeMs =
    noOutputMsPerPiece > 0
      ? noOutputMsPerPiece
      : currentJobs.reduce<number | null>(
          (max, job) =>
            job.cycleTimeMs !== null && (max === null || job.cycleTimeMs > max)
              ? job.cycleTimeMs
              : max,
          null
        );

  return {
    error: null,
    data: {
      workCenter: { id: workCenter.data.id, name: workCenter.data.name },
      timezone,
      shift: {
        id: resolved.shift.id,
        name: resolved.shift.name
      },
      shiftOptions: shiftRows.map((row) => ({ id: row.id, name: row.name })),
      window: { start: resolved.start, end: resolved.end },
      currentJobs,
      cycleTimeMs,
      hours,
      totals,
      status
    }
  };
}
