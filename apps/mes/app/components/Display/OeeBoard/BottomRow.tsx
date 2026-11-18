// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { type OeeBoard, oeeTone } from "@carbon/planning/oee";
import { cn } from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { OeeDisplayData } from "~/services/display.service";
import type { OeeFormats } from "./format";
import { JOB_FILLS, STATE_FILL, TONE_TEXT } from "./format";
import { useOeeLabels } from "./labels";
import { Bar, Panel } from "./Panel";

const ROW =
  "grid grid-cols-[minmax(6em,9.5em)_1fr_3.6em] items-center gap-[0.6em] text-[0.9em]";
const BAR_ROWS = 6;

/** Zone 7: where the planned time went, in minutes, the biggest first. */
export function LossBars({
  board,
  formats
}: {
  board: OeeBoard;
  formats: OeeFormats;
}) {
  const { t } = useLingui();
  const { losses: names } = useOeeLabels();
  const top = Math.max(1, ...board.losses.map((loss) => loss.ms));
  return (
    <Panel
      label={t`Top losses`}
      title={<Trans>Top losses (minutes)</Trans>}
      aside={<Trans>Of planned time</Trans>}
    >
      <div className="flex flex-col gap-[0.45em]">
        {board.losses.length === 0 ? (
          <span className="text-white/55">
            <Trans>No losses yet</Trans>
          </span>
        ) : (
          board.losses.map((loss, index) => (
            <div key={loss.key} className={ROW}>
              <span className="truncate">{names[loss.key]}</span>
              <Bar
                value={loss.ms / top}
                fill={
                  index === 0
                    ? "bg-red-500"
                    : index < 3
                      ? "bg-amber-400"
                      : "bg-sky-500"
                }
              />
              <span className="text-right text-[1.15em] font-semibold tabular-nums">
                {formats.whole(loss.ms / 60_000)}
              </span>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

/** Zone 8: the shift's bad pieces by scrap reason. */
export function ScrapBars({
  board,
  reasonNames,
  formats
}: {
  board: OeeBoard;
  reasonNames: Record<string, string>;
  formats: OeeFormats;
}) {
  const { t } = useLingui();
  const top = Math.max(1, ...board.scrap.map((row) => row.quantity));
  const total = formats.pieces(
    board.scrap.reduce((sum, row) => sum + row.quantity, 0)
  );
  return (
    <Panel
      label={t`Scrap`}
      title={<Trans>Scrap (pieces)</Trans>}
      aside={<Trans>Total {total}</Trans>}
    >
      <div className="flex flex-col gap-[0.45em]">
        {board.scrap.length === 0 ? (
          <span className="text-white/55">
            <Trans>No scrap this shift</Trans>
          </span>
        ) : (
          board.scrap.slice(0, BAR_ROWS).map((row) => (
            <div key={row.scrapReasonId ?? "none"} className={ROW}>
              <span className="truncate">
                {row.scrapReasonId
                  ? (reasonNames[row.scrapReasonId] ?? t`Unknown reason`)
                  : t`No reason given`}
              </span>
              <Bar value={row.quantity / top} fill="bg-red-500" />
              <span className="text-right text-[1.15em] font-semibold tabular-nums">
                {formats.pieces(row.quantity)}
              </span>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

const jobName = (job: {
  jobReadableId: string | null;
  itemReadableId: string | null;
}) => [job.jobReadableId, job.itemReadableId].filter(Boolean).join(" ");

/** Zone 9a: the shift's latest jobs and the one queued next. */
export function JobTable({
  data,
  jobIndex,
  formats
}: {
  data: OeeDisplayData;
  jobIndex: (jobOperationId: string) => number;
  formats: OeeFormats;
}) {
  const { t } = useLingui();
  const currentId = data.currentJob?.jobOperationId;
  const planned = (value: number | null) =>
    value === null ? "—" : formats.pieces(value);
  return (
    <Panel
      label={t`Jobs this shift`}
      title={<Trans>Jobs this shift</Trans>}
      aside={<Trans>Job OEE</Trans>}
    >
      <table className="w-full border-collapse text-[0.88em]">
        <thead>
          <tr className="text-left text-[0.9em] text-white/55">
            <th className="pb-[0.3em] pr-[0.3em] font-medium">
              <Trans>Job / item</Trans>
            </th>
            <th className="pb-[0.3em] pr-[0.3em] text-right font-medium">
              <Trans>Done / plan</Trans>
            </th>
            <th className="pb-[0.3em] text-right font-medium">OEE</th>
          </tr>
        </thead>
        <tbody>
          {data.jobs.map((job) => (
            <tr key={job.jobOperationId} className="border-t border-white/10">
              <td className="max-w-0 truncate py-[0.32em] pr-[0.3em]">
                <i
                  className={cn(
                    "mr-[0.4em] inline-block size-[0.65em] rounded-sm",
                    JOB_FILLS[jobIndex(job.jobOperationId) % JOB_FILLS.length]
                  )}
                />
                {jobName(job)}
                {job.jobOperationId === currentId ? (
                  <span className="text-white/55">
                    {" "}
                    <Trans>(now)</Trans>
                  </span>
                ) : null}
              </td>
              <td className="py-[0.32em] pr-[0.3em] text-right tabular-nums">
                {formats.pieces(job.completeQuantity)}/
                {planned(job.plannedQuantity)}
              </td>
              <td
                className={cn(
                  "py-[0.32em] text-right tabular-nums",
                  TONE_TEXT[oeeTone(job.oee)]
                )}
              >
                {formats.ratio(job.oee)}
              </td>
            </tr>
          ))}
          {data.nextJob ? (
            <tr className="border-t border-white/10 text-white/45">
              <td className="max-w-0 truncate py-[0.32em] pr-[0.3em]">
                {jobName(data.nextJob)} <Trans>(next)</Trans>
              </td>
              <td className="py-[0.32em] pr-[0.3em] text-right tabular-nums">
                0/{planned(data.nextJob.plannedQuantity)}
              </td>
              <td className="py-[0.32em] text-right">–</td>
            </tr>
          ) : null}
          {data.jobs.length === 0 && !data.nextJob ? (
            <tr>
              <td colSpan={3} className="py-[0.32em] text-white/55">
                <Trans>No job has run this shift</Trans>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </Panel>
  );
}

/** Zone 9b: the latest stops of 2 minutes or more. */
export function StopLog({
  board,
  formats
}: {
  board: OeeBoard;
  formats: OeeFormats;
}) {
  const { t } = useLingui();
  const { states } = useOeeLabels();
  return (
    <Panel
      label={t`Stop log`}
      title={<Trans>Stop log</Trans>}
      aside={<Trans>2 minutes or more</Trans>}
    >
      <div className="flex flex-col text-[0.9em]">
        {board.stops.length === 0 ? (
          <span className="text-white/55">
            <Trans>No stops this shift</Trans>
          </span>
        ) : (
          board.stops.map((stop) => {
            const length = formats.minutes(stop.end - stop.start);
            return (
              <div
                key={stop.start}
                className="grid grid-cols-[3.4em_0.7em_1fr_auto] items-center gap-[0.5em] border-b border-white/10 py-[0.38em] last:border-b-0"
              >
                <span className="text-[1.1em] font-semibold tabular-nums">
                  {formats.clock(stop.start)}
                </span>
                <i
                  className={cn(
                    "size-[0.65em] rounded-full",
                    STATE_FILL[stop.state]
                  )}
                />
                <span className="truncate">{states[stop.state]}</span>
                <span
                  className={cn(
                    "text-[1.1em] font-semibold tabular-nums",
                    stop.open && "text-red-400"
                  )}
                >
                  {stop.open ? <Trans>Stopped now {length}</Trans> : length}
                </span>
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}
