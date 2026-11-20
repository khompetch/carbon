// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import type { Database } from "@carbon/database";
import {
  computeSixBigLosses,
  type SixBigLoss,
  type SixBigLossFactor,
  type SixBigLossKey
} from "@carbon/planning/oee";
import { useChangedRows } from "@carbon/query";
import { cn, useInterval } from "@carbon/react";
import { formatDurationMilliseconds } from "@carbon/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useMemo, useState } from "react";
import Avatar from "~/components/Avatar";
import { useUser } from "~/hooks";
import type { OperationLossData } from "~/services/operation-losses.server";
import { usePeople } from "~/stores";
import { openStopOf } from "../hooks/useOperationLosses";
import { StopBanner } from "./OperationStops";

type ProductionEvent = Database["public"]["Tables"]["productionEvent"]["Row"];
type WorkType = "Setup" | "Labor" | "Machine";

/**
 * The top of the operation page: the stop strip, the quantities in large
 * type, who is working, and the operation's Six Big Losses.
 */
export function OperationOverview({
  operationId,
  batchId,
  events,
  losses,
  quantity
}: {
  operationId: string;
  batchId?: string | null;
  events: ProductionEvent[];
  losses: OperationLossData | null;
  quantity: {
    complete: number;
    target: number;
    scrapped: number;
    reworked: number;
  };
}) {
  const liveEvents = useLiveEvents({ operationId, batchId, events });
  const openStop = openStopOf(losses);

  return (
    <div className="flex flex-col gap-6 p-4 lg:p-6">
      {openStop && <StopBanner operationId={operationId} stop={openStop} />}
      <QuantityHero {...quantity} />
      <ActiveOperators events={liveEvents} />
      <SixBigLosses events={liveEvents} losses={losses} />
    </div>
  );
}

/**
 * The loader's events with realtime changes laid over them: a row that
 * changed since the loader ran wins, a deleted row is gone.
 */
function useLiveEvents({
  operationId,
  batchId,
  events
}: {
  operationId: string;
  batchId?: string | null;
  events: ProductionEvent[];
}) {
  const user = useUser();
  const [changes, setChanges] = useState<{
    rows: Map<string, ProductionEvent>;
    deleted: Set<string>;
  }>(() => ({ rows: new Map(), deleted: new Set() }));

  useChangedRows<ProductionEvent>({
    companyId: user.company.id,
    table: "productionEvent",
    filter: batchId
      ? `jobOperationBatchId=eq.${batchId}`
      : `jobOperationId=eq.${operationId}`,
    onChange: ({ op, ids, rows }) => {
      setChanges((prev) => {
        const next = {
          rows: new Map(prev.rows),
          deleted: new Set(prev.deleted)
        };
        if (op === "DELETE") {
          for (const id of ids) next.deleted.add(id);
        } else {
          for (const row of rows) next.rows.set(row.id, row);
        }
        return next;
      });
    }
  });

  return useMemo(() => {
    const byId = new Map(events.map((event) => [event.id, event]));
    for (const [id, row] of changes.rows) byId.set(id, row);
    for (const id of changes.deleted) byId.delete(id);
    return [...byId.values()];
  }, [events, changes]);
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), active ? 1000 : null);
  return now;
}

function QuantityHero({
  complete,
  target,
  scrapped,
  reworked
}: {
  complete: number;
  target: number;
  scrapped: number;
  reworked: number;
}) {
  const remaining = Math.max(0, target - complete);
  const total = Math.max(target, complete + scrapped + reworked, 1);
  const percent =
    target > 0 ? Math.min(100, Math.round((complete / target) * 100)) : 0;
  const segment = (value: number) => `${(value / total) * 100}%`;

  return (
    <section
      aria-labelledby="operation-quantity"
      className="flex flex-col gap-4"
    >
      <h2 id="operation-quantity" className="sr-only">
        <Trans>Quantity</Trans>
      </h2>
      <div className="grid grid-cols-3 gap-3 lg:grid-cols-4">
        <Stat
          label={<Trans>Completed</Trans>}
          value={complete}
          detail={<Trans>of {target}</Trans>}
          className="col-span-3 lg:col-span-1"
          valueClassName="text-emerald-600 dark:text-emerald-400"
        />
        <Stat label={<Trans>Remaining</Trans>} value={remaining} />
        <Stat
          label={<Trans>Scrapped</Trans>}
          value={scrapped}
          valueClassName={
            scrapped > 0 ? "text-red-600 dark:text-red-400" : undefined
          }
        />
        <Stat
          label={<Trans>Reworked</Trans>}
          value={reworked}
          valueClassName={
            reworked > 0 ? "text-amber-600 dark:text-amber-400" : undefined
          }
        />
      </div>
      <div className="flex items-center gap-4">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="flex h-4 flex-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full bg-emerald-500"
            style={{ width: segment(complete) }}
          />
          <div
            className="h-full bg-amber-500"
            style={{ width: segment(reworked) }}
          />
          <div
            className="h-full bg-red-500"
            style={{ width: segment(scrapped) }}
          />
        </div>
        <span className="w-16 shrink-0 text-right text-2xl font-semibold tabular-nums">
          {percent}%
        </span>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  detail,
  className,
  valueClassName
}: {
  label: ReactNode;
  value: number;
  detail?: ReactNode;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-4",
        className
      )}
    >
      <span className="text-base font-medium text-muted-foreground">
        {label}
      </span>
      <span className="flex min-w-0 items-baseline gap-2">
        <span
          className={cn(
            "truncate text-5xl font-semibold leading-none tabular-nums lg:text-6xl",
            valueClassName
          )}
        >
          {value}
        </span>
        {detail && (
          <span className="shrink-0 text-xl text-muted-foreground tabular-nums">
            {detail}
          </span>
        )}
      </span>
    </div>
  );
}

const WORK_TYPE_DOT: Record<WorkType, string> = {
  Setup: "bg-blue-500",
  Labor: "bg-emerald-500",
  Machine: "bg-violet-500"
};

function ActiveOperators({ events }: { events: ProductionEvent[] }) {
  const { t } = useLingui();
  const [people] = usePeople();
  const workTypeLabel: Record<WorkType, string> = {
    Setup: t`Setup`,
    Labor: t`Labor`,
    Machine: t`Machine`
  };

  const working = useMemo(() => {
    const byEmployee = new Map<
      string,
      { employeeId: string; types: Set<WorkType>; since: number }
    >();
    for (const event of events) {
      if (event.endTime !== null || !event.employeeId || !event.startTime)
        continue;
      const start = Date.parse(event.startTime);
      const entry = byEmployee.get(event.employeeId) ?? {
        employeeId: event.employeeId,
        types: new Set<WorkType>(),
        since: start
      };
      entry.types.add(event.type as WorkType);
      entry.since = Math.min(entry.since, start);
      byEmployee.set(event.employeeId, entry);
    }
    return [...byEmployee.values()].sort((a, b) => a.since - b.since);
  }, [events]);

  const now = useNow(working.length > 0);

  return (
    <section aria-labelledby="working-now" className="flex flex-col gap-3">
      <h2
        id="working-now"
        className="flex items-center gap-2 text-lg font-semibold"
      >
        <Trans>Working now</Trans>
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-sm tabular-nums text-muted-foreground">
          {working.length}
        </span>
      </h2>
      {working.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-base text-muted-foreground">
          <Trans>No one is working on this operation.</Trans>
        </p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-3">
          {working.map((entry) => {
            const person = people.find((p) => p.id === entry.employeeId);
            const name = person?.name ?? t`Unknown employee`;
            return (
              <li
                key={entry.employeeId}
                className="flex min-w-0 items-center gap-3 rounded-xl border bg-card p-3"
              >
                <Avatar
                  size="md"
                  path={person?.avatarUrl ?? undefined}
                  name={name}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-lg font-semibold">{name}</span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    {[...entry.types].map((type) => (
                      <span
                        key={type}
                        className="inline-flex items-center gap-1.5"
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "size-2 animate-pulse rounded-full",
                            WORK_TYPE_DOT[type]
                          )}
                        />
                        {workTypeLabel[type]}
                      </span>
                    ))}
                    <span className="font-mono tabular-nums">
                      {formatDurationMilliseconds(
                        Math.max(0, now - entry.since),
                        {
                          style: "short"
                        }
                      )}
                    </span>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SixBigLosses({
  events,
  losses
}: {
  events: ProductionEvent[];
  losses: OperationLossData | null;
}) {
  const { t } = useLingui();
  const running =
    !!openStopOf(losses) ||
    events.some((event) => event.type === "Setup" && event.endTime === null);
  const now = useNow(running);

  const rows = useMemo<SixBigLoss[] | null>(() => {
    if (!losses) return null;
    return computeSixBigLosses({
      now,
      setupEvents: events
        .filter((event) => event.type === "Setup" && event.startTime)
        .map((event) => ({
          startTime: Date.parse(event.startTime as string),
          endTime: event.endTime ? Date.parse(event.endTime) : null
        })),
      stops: losses.stops.map((stop) => ({
        startTime: Date.parse(stop.startTime),
        endTime: stop.endTime ? Date.parse(stop.endTime) : null,
        oeeLoss: stop.oeeLoss
      })),
      rejects: losses.rejects,
      speedLossMs: losses.speedLossMs
    });
  }, [losses, events, now]);

  const labels: Record<SixBigLossKey, string> = {
    breakdowns: t`Breakdowns`,
    setupAdjustments: t`Setup & adjustments`,
    smallStops: t`Small stops`,
    reducedSpeed: t`Reduced speed`,
    startupRejects: t`Startup rejects`,
    productionRejects: t`Production rejects`
  };
  const factors: { factor: SixBigLossFactor; label: string }[] = [
    { factor: "availability", label: t`Availability` },
    { factor: "performance", label: t`Performance` },
    { factor: "quality", label: t`Quality` }
  ];

  return (
    <section aria-labelledby="six-big-losses" className="flex flex-col gap-3">
      <h2 id="six-big-losses" className="text-lg font-semibold">
        <Trans>Six Big Losses</Trans>
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          <Trans>this operation</Trans>
        </span>
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {factors.map(({ factor, label }) => {
          const group = rows?.filter((row) => row.factor === factor) ?? [];
          return (
            <div
              key={factor}
              className="flex flex-col gap-2 rounded-xl border bg-card p-3"
            >
              <span className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                {label}
              </span>
              <div className="grid grid-cols-2 gap-2">
                {rows === null
                  ? [0, 1].map((key) => (
                      <div
                        key={key}
                        className="h-20 animate-pulse rounded-lg bg-muted"
                      />
                    ))
                  : group.map((row) => (
                      <LossTile
                        key={row.key}
                        label={labels[row.key]}
                        loss={row}
                        unknownLabel={t`No standard`}
                        unit={row.unit === "minutes" ? t`min` : t`pcs`}
                      />
                    ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LossTile({
  label,
  loss,
  unit,
  unknownLabel
}: {
  label: string;
  loss: SixBigLoss;
  unit: string;
  unknownLabel: string;
}) {
  const hasLoss = (loss.value ?? 0) > 0;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg p-3",
        hasLoss ? "bg-red-500/10" : "bg-muted/50"
      )}
    >
      <span className="line-clamp-2 text-sm text-muted-foreground">
        {label}
      </span>
      {loss.value === null ? (
        <span className="text-base text-muted-foreground">{unknownLabel}</span>
      ) : (
        <span className="flex items-baseline gap-1">
          <span
            className={cn(
              "text-3xl font-semibold leading-none tabular-nums",
              hasLoss
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground"
            )}
          >
            {loss.value}
          </span>
          <span className="text-sm text-muted-foreground">{unit}</span>
        </span>
      )}
    </div>
  );
}
