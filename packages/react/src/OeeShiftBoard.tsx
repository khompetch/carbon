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
  }[];
  /** standard cycle time of the running operation(s), ms per piece */
  cycleTimeMs?: number | null;
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
  threshold
}: {
  value: number | null;
  threshold: number;
}) {
  return (
    <td
      className={cn(
        "px-2 py-1 text-center tabular-nums font-semibold",
        value === null
          ? "text-muted-foreground"
          : value >= threshold
            ? "text-emerald-500"
            : "text-red-500"
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

function hourLabel(startMs: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(startMs));
}

export function OeeShiftBoard({
  workCenterName,
  status,
  shiftName,
  window: shiftWindow,
  timezone,
  currentJobs,
  cycleTimeMs,
  hours,
  totals,
  className
}: OeeShiftBoardProps) {
  const statusStyle = STATUS_STYLES[status];
  const all = totals.good + totals.defect;

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
        <div className="text-xl md:text-3xl font-bold shrink-0">
          <Clock timezone={timezone} />
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

      {/* Hourly table */}
      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-base md:text-lg">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-2 py-1 text-left">#</th>
              {hours.map((hour) => (
                <th
                  key={hour.start}
                  className="px-2 py-1 text-center tabular-nums whitespace-nowrap"
                >
                  {hourLabel(hour.start, timezone)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b">
              <th className="px-2 py-1 text-left whitespace-nowrap">%A</th>
              {hours.map((hour) => (
                <PercentCell
                  key={hour.start}
                  value={hour.availability}
                  threshold={THRESHOLDS.availability}
                />
              ))}
            </tr>
            <tr className="border-b">
              <th className="px-2 py-1 text-left whitespace-nowrap">%P</th>
              {hours.map((hour) => (
                <PercentCell
                  key={hour.start}
                  value={hour.performance}
                  threshold={THRESHOLDS.performance}
                />
              ))}
            </tr>
            <tr className="border-b">
              <th className="px-2 py-1 text-left whitespace-nowrap">%Q</th>
              {hours.map((hour) => (
                <PercentCell
                  key={hour.start}
                  value={hour.quality}
                  threshold={THRESHOLDS.quality}
                />
              ))}
            </tr>
            <tr className="border-b">
              <th className="px-2 py-1 text-left whitespace-nowrap">%OEE</th>
              {hours.map((hour) => (
                <PercentCell
                  key={hour.start}
                  value={hour.oee}
                  threshold={THRESHOLDS.oee}
                />
              ))}
            </tr>
            <tr className="border-b">
              <th className="px-2 py-1 text-left whitespace-nowrap">PDT</th>
              {hours.map((hour) => (
                <td
                  key={hour.start}
                  className="px-2 py-1 text-center tabular-nums"
                >
                  {minutes(hour.pdtMs)}
                </td>
              ))}
            </tr>
            <tr className="border-b">
              <th className="px-2 py-1 text-left whitespace-nowrap">UPDT</th>
              {hours.map((hour) => (
                <td
                  key={hour.start}
                  className="px-2 py-1 text-center tabular-nums"
                >
                  {minutes(hour.updtMs)}
                </td>
              ))}
            </tr>
            <tr className="border-b">
              <th className="px-2 py-1 text-left whitespace-nowrap">
                <Trans>TARGET</Trans>
              </th>
              {hours.map((hour) => (
                <td
                  key={hour.start}
                  className="px-2 py-1 text-center tabular-nums"
                >
                  {hour.target}
                </td>
              ))}
            </tr>
            <tr className="border-b">
              <th className="px-2 py-1 text-left whitespace-nowrap">NG</th>
              {hours.map((hour) => (
                <td
                  key={hour.start}
                  className="px-2 py-1 text-center tabular-nums"
                >
                  {hour.defect}
                </td>
              ))}
            </tr>
            <tr>
              <th className="px-2 py-1 text-left whitespace-nowrap">OK</th>
              {hours.map((hour) => (
                <td
                  key={hour.start}
                  className="px-2 py-1 text-center tabular-nums font-semibold"
                >
                  {hour.good}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
