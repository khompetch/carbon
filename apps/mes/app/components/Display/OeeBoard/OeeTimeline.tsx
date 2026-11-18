// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import type { OeeBoard, OeeBoardState } from "@carbon/planning/oee";
import { cn } from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { OeeFormats } from "./format";
import { JOB_FILLS, STATE_FILL } from "./format";
import { useOeeLabels } from "./labels";
import { Panel } from "./Panel";

const AXIS_STEP_MS = 2 * 3_600_000;
const LEGEND: OeeBoardState[] = [
  "Running",
  "Idle",
  "Down",
  "Offline",
  "Unknown",
  "NotPlanned"
];

/** Zone 4: the whole shift, jobs on top and machine states below. */
export function OeeTimeline({
  board,
  jobNames,
  formats
}: {
  board: OeeBoard;
  /** A short name per operation id, for the job bar. */
  jobNames: Map<string, string>;
  formats: OeeFormats;
}) {
  const { t } = useLingui();
  const { states: stateLabels } = useOeeLabels();
  const { shift } = board;
  const length = Math.max(1, shift.end - shift.start);
  const left = (at: number) => `${((at - shift.start) / length) * 100}%`;
  const width = (start: number, end: number) =>
    `${((end - start) / length) * 100}%`;
  const ticks: number[] = [];
  for (let at = shift.start; at <= shift.end; at += AXIS_STEP_MS)
    ticks.push(at);
  const order = new Map(
    board.jobs.map((job, index) => [job.jobOperationId, index])
  );

  return (
    <Panel
      label={t`Job and machine state timeline`}
      title={<Trans>Jobs (top) and machine state (bottom)</Trans>}
      aside={`${formats.clock(shift.start)}–${formats.clock(shift.end)}`}
    >
      <div className="relative mb-[0.25em] h-[1.7em] overflow-hidden rounded-md bg-white/10">
        {board.jobSpans.map((span) => {
          const name = jobNames.get(span.jobOperationId) ?? "";
          const fill =
            JOB_FILLS[(order.get(span.jobOperationId) ?? 0) % JOB_FILLS.length];
          return (
            <span
              key={`${span.jobOperationId}-${span.start}`}
              title={name}
              className={cn(
                "absolute inset-y-0 truncate border-r-2 border-zinc-900 px-[0.4em] text-[0.78em] font-medium leading-[2.2em] text-white",
                fill
              )}
              style={{
                left: left(span.start),
                width: width(span.start, span.end)
              }}
            >
              {name}
            </span>
          );
        })}
      </div>
      <div
        className="relative h-[1em] overflow-hidden rounded-md bg-white/10"
        role="img"
        aria-label={t`Machine state since the start of the shift`}
      >
        {board.states.map((segment) => (
          <span
            key={`${segment.state}-${segment.start}`}
            className={cn("absolute inset-y-0", STATE_FILL[segment.state])}
            style={{
              left: left(segment.start),
              width: width(segment.start, segment.end)
            }}
          />
        ))}
        <span
          className="absolute inset-y-0 w-[2px] bg-white"
          style={{ left: left(board.period.end) }}
        />
      </div>
      <div className="mt-[0.25em] flex justify-between text-[0.75em] text-white/55 tabular-nums">
        {ticks.map((at) => (
          <span key={at}>{formats.hour(at)}</span>
        ))}
      </div>
      <div className="mt-[0.4em] flex flex-wrap gap-x-[1em] gap-y-[0.3em] text-[0.78em] text-white/55">
        {LEGEND.map((state) => (
          <span key={state} className="flex items-center gap-[0.35em]">
            <b
              className={cn(
                "inline-block size-[0.75em] rounded-sm",
                STATE_FILL[state]
              )}
            />
            {stateLabels[state]}
          </span>
        ))}
      </div>
    </Panel>
  );
}
