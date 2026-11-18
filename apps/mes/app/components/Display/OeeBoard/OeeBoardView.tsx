// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { cn } from "@carbon/react";
import { Trans } from "@lingui/react/macro";
import type { OeeDisplayData } from "~/services/display.service";
import type { OeeBoardAlert } from "~/utils/display";
import { AlertStrip } from "./AlertStrip";
import { JobTable, LossBars, ScrapBars, StopLog } from "./BottomRow";
import { CurrentJob } from "./CurrentJob";
import { STATE_FILL, useOeeFormats } from "./format";
import { HourlyBars } from "./HourlyBars";
import { KpiTiles } from "./KpiTiles";
import { useOeeLabels } from "./labels";
import { OeeSummary } from "./OeeSummary";
import { OeeTimeline } from "./OeeTimeline";

// From 1100 px wide the board is one screen with no scroll: three columns
// (1 : 1.75 : 1.15) over a bottom row 27% high (1 : 0.9 : 1.15 : 1.2).
// Narrower, the zones stack in their number order and the page scrolls.
// (Literal class names: Tailwind only finds whole strings.)

/**
 * The OEE line board: ten zones in fixed places on every work center, so an
 * operator reads any board from across the floor the same way.
 */
export function OeeBoardView({
  data,
  source,
  alerts,
  timeZone
}: {
  data: OeeDisplayData;
  source: "Sensor" | "Operator";
  alerts: OeeBoardAlert[];
  timeZone: string;
}) {
  const formats = useOeeFormats(timeZone);
  const { board } = data;
  const order = new Map(
    board.jobs.map((job, index) => [job.jobOperationId, index])
  );
  const jobIndex = (jobOperationId: string) =>
    order.get(jobOperationId) ?? board.jobs.length;
  const jobNames = new Map(
    data.jobs.map((job) => [job.jobOperationId, job.jobReadableId ?? ""])
  );

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-[0.7em] overflow-y-auto p-[0.8em] leading-[1.45]",
        "min-[1100px]:overflow-hidden"
      )}
      style={{ fontSize: "clamp(14px, 0.92vw, 24px)" }}
    >
      <div
        className={cn(
          "flex flex-col gap-[0.7em]",
          "min-[1100px]:grid min-[1100px]:min-h-0 min-[1100px]:flex-1 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,1.75fr)_minmax(0,1.15fr)]"
        )}
      >
        <OeeSummary
          board={board}
          previousShiftOee={data.previousShiftOee}
          formats={formats}
        />
        <div
          className={cn(
            "flex min-h-0 flex-col gap-[0.7em]",
            "min-[1100px]:grid min-[1100px]:grid-rows-[auto_auto_minmax(10em,1fr)]"
          )}
        >
          <CurrentJob
            job={data.currentJob}
            jobIndex={
              data.currentJob ? jobIndex(data.currentJob.jobOperationId) : 0
            }
            formats={formats}
          />
          <OeeTimeline board={board} jobNames={jobNames} formats={formats} />
          <HourlyBars board={board} formats={formats} />
        </div>
        <KpiTiles board={board} source={source} formats={formats} />
      </div>
      <div
        className={cn(
          "flex flex-col gap-[0.7em]",
          "min-[1100px]:grid min-[1100px]:min-h-0 min-[1100px]:shrink-0 min-[1100px]:basis-[27%] min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.15fr)_minmax(0,1.2fr)]"
        )}
      >
        <LossBars board={board} formats={formats} />
        <ScrapBars
          board={board}
          reasonNames={data.scrapReasonNames}
          formats={formats}
        />
        <JobTable data={data} jobIndex={jobIndex} formats={formats} />
        <StopLog board={board} formats={formats} />
      </div>
      <AlertStrip alerts={alerts} now={board.period.end} formats={formats} />
    </div>
  );
}

/** The header detail: the machine state now, for how long, and the job. */
export function OeeBoardHeaderDetail({
  data,
  timeZone
}: {
  data: OeeDisplayData;
  timeZone: string;
}) {
  const formats = useOeeFormats(timeZone);
  const { states } = useOeeLabels();
  const { current, shift, period } = data.board;
  const job = data.currentJob;
  const range = `${formats.clock(shift.start)}–${formats.clock(shift.end)}`;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-[1.2em] gap-y-[0.3em] normal-case tracking-normal">
      {current ? (
        <span className="inline-flex items-center gap-[0.5em] rounded-full bg-black/30 px-[0.9em] py-[0.3em] font-semibold">
          <i
            className={cn(
              "inline-block size-[0.7em] rounded-full",
              STATE_FILL[current.state]
            )}
          />
          {states[current.state]}
          <span className="tabular-nums">
            {formats.minutes(period.end - current.since)}
          </span>
        </span>
      ) : null}
      {job ? (
        <span className="truncate font-medium">
          {[job.jobReadableId, job.itemReadableId, job.itemName]
            .filter(Boolean)
            .join(" · ")}
        </span>
      ) : null}
      <span className="font-normal text-white/80">
        {data.alwaysOn ? (
          <Trans>Today {range}</Trans>
        ) : (
          <Trans>Shift {range}</Trans>
        )}
      </span>
    </div>
  );
}
