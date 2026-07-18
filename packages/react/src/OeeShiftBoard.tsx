import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { cn } from "./utils/cn";

/**
 * Shop-floor TV board for one work center's current 12-hour shift, broken
 * down hour by hour. Pure presentational — both ERP and MES fetch the data
 * (computeShiftHourlyOee from @carbon/utils) and render this.
 */

type HourBucket = {
  start: number;
  end: number;
  elapsedMs: number;
  pdtMs: number;
  updtMs: number;
  runtimeMs: number;
  good: number;
  defect: number;
  target: number;
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
};

type ShiftTotals = {
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

export type OeeShiftBoardProps = {
  workCenterName: string;
  status: "running" | "planned-downtime" | "unplanned-downtime" | "idle";
  shiftName: string;
  window: { start: number; end: number };
  timezone: string;
  currentJobs: {
    id: string;
    jobReadableId: string | null;
    itemReadableId: string | null;
    itemName: string | null;
    description: string | null;
    cycleTimeMs?: number | null;
    quantityComplete?: number;
    operationQuantity?: number | null;
  }[];
  /** standard cycle time of the running operation(s), ms per piece */
  cycleTimeMs?: number | null;
  /** when set, shows a countdown to the next periodic data refresh */
  refreshIntervalMs?: number;
  hours: HourBucket[];
  totals: ShiftTotals;
  className?: string;
};

const THRESHOLDS = {
  availability: 0.9,
  performance: 0.85,
  quality: 0.95,
  oee: 0.85
};

const STATUS_STYLES: Record<
  OeeShiftBoardProps["status"],
  { bar: string; label: React.ReactNode }
> = {
  running: {
    bar: "bg-emerald-600 text-white",
    label: <Trans>Running</Trans>
  },
  "planned-downtime": {
    bar: "bg-yellow-500 text-black",
    label: <Trans>Planned Downtime</Trans>
  },
  "unplanned-downtime": {
    bar: "bg-red-600 text-white",
    label: <Trans>Unplanned Downtime</Trans>
  },
  idle: {
    bar: "bg-muted text-muted-foreground",
    label: <Trans>Idle</Trans>
  }
};

function percent(value: number | null): string {
  if (value === null) return "–";
  return (value * 100).toFixed(value >= 1 ? 0 : 1);
}

function minutes(ms: number): string {
  return (ms / 60000).toFixed(ms > 0 && ms < 60000 ? 1 : 0);
}

/** Cycle time as "36.0 s/pc" below a minute, "2.5 min/pc" above */
function cycleTime(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s/pc`;
  return `${(ms / 60000).toFixed(1)} min/pc`;
}

function PercentCell({
  value,
  threshold,
  highlight,
  className
}: {
  value: number | null;
  threshold: number;
  highlight?: boolean;
  className?: string;
}) {
  return (
    <td
      className={cn(
        "px-2 py-1 text-center tabular-nums font-semibold",
        highlight && "bg-accent/40",
        value === null
          ? "text-muted-foreground"
          : value >= threshold
            ? "text-emerald-500"
            : "text-red-500",
        className
      )}
    >
      {percent(value)}
    </td>
  );
}

function Clock({ timezone }: { timezone: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);
  return (
    <span className="tabular-nums">
      {new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      })
        .format(now)
        .replace(",", "")}
    </span>
  );
}

function RefreshCountdown({
  intervalMs,
  resetKey
}: {
  intervalMs: number;
  resetKey: unknown;
}) {
  const totalSeconds = Math.max(1, Math.round(intervalMs / 1000));
  const [secondsLeft, setSecondsLeft] = useState(totalSeconds);

  // New data arrived (periodic or realtime refresh) — restart the countdown
  useEffect(() => {
    setSecondsLeft(totalSeconds);
  }, [resetKey, totalSeconds]);

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsLeft((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <span className="text-xs md:text-sm font-medium opacity-80 tabular-nums whitespace-nowrap">
      <Trans>Refresh in {secondsLeft}s</Trans>
    </span>
  );
}

function hourLabel(startMs: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(startMs));
}

/**
 * Index of the hour bucket that contains "now", or -1. SSR-safe: returns -1 on
 * the server and the first client render (no `Date.now()` during render, so no
 * hydration mismatch), then resolves after mount and re-checks every 30s.
 */
function useCurrentHourIndex(hours: HourBucket[]): number {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, []);
  if (now === null) return -1;
  return hours.findIndex((hour) => now >= hour.start && now < hour.end);
}

export function OeeShiftBoard({
  workCenterName,
  status,
  shiftName,
  window: shiftWindow,
  timezone,
  currentJobs,
  cycleTimeMs,
  refreshIntervalMs,
  hours,
  totals,
  className
}: OeeShiftBoardProps) {
  const statusStyle = STATUS_STYLES[status];
  const all = totals.good + totals.defect;
  const currentHourIndex = useCurrentHourIndex(hours);

  return (
    <div className={cn("flex flex-col gap-3 w-full", className)}>
      {/* Header: work center + status + live clock */}
      <div
        className={cn(
          "flex items-center justify-between rounded-lg px-4 py-3",
          statusStyle.bar
        )}
      >
        <h1 className="text-2xl md:text-4xl font-bold truncate">
          {workCenterName}{" "}
          <span className="font-medium opacity-90">({statusStyle.label})</span>
        </h1>
        <div className="flex flex-col items-end shrink-0">
          <div className="text-xl md:text-3xl font-bold">
            <Clock timezone={timezone} />
          </div>
          {refreshIntervalMs !== undefined && (
            <RefreshCountdown
              intervalMs={refreshIntervalMs}
              resetKey={totals}
            />
          )}
        </div>
      </div>

      {/* Current job orders */}
      {currentJobs.length > 0 && (
        <div className="rounded-lg border overflow-x-auto">
          <table className="w-full text-lg md:text-xl">
            <tbody>
              {currentJobs.map((job) => (
                <tr key={job.id} className="border-b last:border-b-0">
                  <td className="px-3 py-2 font-bold whitespace-nowrap">
                    {job.jobReadableId ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono whitespace-nowrap">
                    {job.itemReadableId ?? ""}
                  </td>
                  <td className="px-3 py-2 truncate">
                    {job.itemName ?? job.description ?? ""}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {job.quantityComplete !== undefined ? (
                      <div className="flex flex-col items-end gap-1 min-w-[7rem]">
                        <span className="tabular-nums font-semibold">
                          {job.quantityComplete}
                          {job.operationQuantity != null &&
                            job.operationQuantity > 0 && (
                              <span className="text-muted-foreground font-normal">
                                {" / "}
                                {job.operationQuantity}
                              </span>
                            )}
                        </span>
                        {job.operationQuantity != null &&
                          job.operationQuantity > 0 && (
                            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                              <div
                                className={cn(
                                  "h-full rounded-full",
                                  job.quantityComplete >= job.operationQuantity
                                    ? "bg-emerald-500"
                                    : "bg-blue-500"
                                )}
                                style={{
                                  width: `${Math.min(
                                    100,
                                    (job.quantityComplete /
                                      job.operationQuantity) *
                                      100
                                  )}%`
                                }}
                              />
                            </div>
                          )}
                      </div>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-muted-foreground">
                    {job.cycleTimeMs != null ? (
                      <>
                        <span className="text-xs uppercase mr-1">
                          <Trans>CT</Trans>
                        </span>
                        {cycleTime(job.cycleTimeMs)}
                      </>
                    ) : (
                      "–"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Summary row: times, pieces, A/P/Q, OEE */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
        <div className="md:col-span-3 rounded-lg border p-3">
          <table className="w-full text-base md:text-lg">
            <tbody>
              <tr>
                <th className="text-left font-medium py-1">
                  <Trans>Working Time (min)</Trans>
                </th>
                <td className="text-right tabular-nums">
                  {minutes(totals.elapsedMs)}
                </td>
              </tr>
              <tr>
                <th className="text-left font-medium py-1">
                  <Trans>Plan Downtime (min)</Trans>
                </th>
                <td className="text-right tabular-nums">
                  {minutes(totals.pdtMs)}
                </td>
              </tr>
              <tr>
                <th className="text-left font-medium py-1">
                  <Trans>Unplan Downtime (min)</Trans>
                </th>
                <td className="text-right tabular-nums">
                  {minutes(totals.updtMs)}
                </td>
              </tr>
              <tr>
                <th className="text-left font-medium py-1">
                  <Trans>Runtime (min)</Trans>
                </th>
                <td className="text-right tabular-nums">
                  {minutes(totals.runtimeMs)}
                </td>
              </tr>
              <tr>
                <th className="text-left font-medium py-1">
                  <Trans>Cycle Time</Trans>
                </th>
                <td className="text-right tabular-nums">
                  {cycleTimeMs != null ? cycleTime(cycleTimeMs) : "–"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="md:col-span-2 rounded-lg border p-3">
          <table className="w-full text-base md:text-lg">
            <tbody>
              <tr>
                <th className="text-left font-medium py-1">
                  <Trans>OK (pcs)</Trans>
                </th>
                <td className="text-right tabular-nums">{totals.good}</td>
              </tr>
              <tr>
                <th className="text-left font-medium py-1">
                  <Trans>NG (pcs)</Trans>
                </th>
                <td className="text-right tabular-nums">{totals.defect}</td>
              </tr>
              <tr>
                <th className="text-left font-medium py-1">
                  <Trans>ALL (pcs)</Trans>
                </th>
                <td className="text-right tabular-nums">{all}</td>
              </tr>
              <tr>
                <th className="text-left font-medium py-1">
                  <Trans>STD (pcs)</Trans>
                </th>
                <td className="text-right tabular-nums">{totals.target}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="md:col-span-4 rounded-lg border p-3">
          <table className="w-full text-base md:text-lg">
            <tbody>
              {(
                [
                  ["availability", <Trans key="a">Availability (%A)</Trans>],
                  ["performance", <Trans key="p">Performance (%P)</Trans>],
                  ["quality", <Trans key="q">Quality (%Q)</Trans>]
                ] as const
              ).map(([key, label]) => {
                const value = totals[key] as number | null;
                const threshold = THRESHOLDS[key];
                return (
                  <tr key={key}>
                    <th className="text-left font-medium py-1">{label}</th>
                    <td
                      className={cn(
                        "text-right text-2xl md:text-3xl font-bold tabular-nums",
                        value === null
                          ? "text-muted-foreground"
                          : value >= threshold
                            ? "text-emerald-500"
                            : "text-red-500"
                      )}
                    >
                      {percent(value)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="md:col-span-3 rounded-lg border p-3 flex flex-col items-center justify-center text-center">
          <div className="font-semibold text-base md:text-lg">
            <Trans>%OEE ({shiftName})</Trans>
          </div>
          <div
            className={cn(
              "text-5xl md:text-7xl font-bold tabular-nums",
              totals.oee === null
                ? "text-muted-foreground"
                : totals.oee >= THRESHOLDS.oee
                  ? "text-emerald-500"
                  : "text-red-500"
            )}
          >
            {percent(totals.oee)}
          </div>
        </div>
      </div>

      {/* Hourly table — grouped by cause→effect: %OEE headline, then A/P/Q,
          then the time rows that drive %A, then the count rows that drive
          %P/%Q. The current hour's column is highlighted. */}
      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-base md:text-lg">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-2 py-1 text-left">#</th>
              {hours.map((hour, i) => (
                <th
                  key={hour.start}
                  className={cn(
                    "px-2 py-1 text-center tabular-nums whitespace-nowrap",
                    i === currentHourIndex && "bg-accent/40"
                  )}
                >
                  {hourLabel(hour.start, timezone)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* %OEE — headline */}
            <tr className="border-b-2 border-border bg-muted/30">
              <th className="px-2 py-1 text-left whitespace-nowrap font-bold">
                %OEE
              </th>
              {hours.map((hour, i) => (
                <PercentCell
                  key={hour.start}
                  value={hour.oee}
                  threshold={THRESHOLDS.oee}
                  highlight={i === currentHourIndex}
                  className="text-lg md:text-xl font-bold"
                />
              ))}
            </tr>

            {/* Availability / Performance / Quality */}
            {(
              [
                ["%A", "availability", THRESHOLDS.availability],
                ["%P", "performance", THRESHOLDS.performance],
                ["%Q", "quality", THRESHOLDS.quality]
              ] as const
            ).map(([label, key, threshold], idx, arr) => (
              <tr
                key={key}
                className={
                  idx === arr.length - 1
                    ? "border-b-2 border-border"
                    : "border-b"
                }
              >
                <th className="px-2 py-1 text-left whitespace-nowrap">
                  {label}
                </th>
                {hours.map((hour, i) => (
                  <PercentCell
                    key={hour.start}
                    value={hour[key]}
                    threshold={threshold}
                    highlight={i === currentHourIndex}
                  />
                ))}
              </tr>
            ))}

            {/* Time block — drives %A */}
            {(
              [
                ["RT (min)", "runtimeMs"],
                ["PDT (min)", "pdtMs"],
                ["UPDT (min)", "updtMs"]
              ] as const
            ).map(([label, key], idx, arr) => (
              <tr
                key={key}
                className={
                  idx === arr.length - 1
                    ? "border-b-2 border-border"
                    : "border-b"
                }
              >
                <th className="px-2 py-1 text-left whitespace-nowrap">
                  {label}
                </th>
                {hours.map((hour, i) => (
                  <td
                    key={hour.start}
                    className={cn(
                      "px-2 py-1 text-center tabular-nums",
                      i === currentHourIndex && "bg-accent/40"
                    )}
                  >
                    {minutes(hour[key])}
                  </td>
                ))}
              </tr>
            ))}

            {/* Count block — drives %P / %Q (goal → good → bad) */}
            {(
              [
                ["TARGET (pcs)", "target", false],
                ["OK (pcs)", "good", true],
                ["NG (pcs)", "defect", false]
              ] as const
            ).map(([label, key, bold], idx, arr) => (
              <tr
                key={key}
                className={idx === arr.length - 1 ? "" : "border-b"}
              >
                <th className="px-2 py-1 text-left whitespace-nowrap">
                  {label}
                </th>
                {hours.map((hour, i) => (
                  <td
                    key={hour.start}
                    className={cn(
                      "px-2 py-1 text-center tabular-nums",
                      bold && "font-semibold",
                      i === currentHourIndex && "bg-accent/40"
                    )}
                  >
                    {hour[key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
