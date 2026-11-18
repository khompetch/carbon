// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { oeeTone } from "@carbon/planning/oee";
import { cn } from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { OeeDisplayData } from "~/services/display.service";
import type { OeeFormats } from "./format";
import { JOB_FILLS, TONE_TEXT } from "./format";
import { Bar, Panel } from "./Panel";

/** Zone 3: the job loaded on the work center, its progress and its finish. */
export function CurrentJob({
  job,
  jobIndex,
  formats
}: {
  job: OeeDisplayData["currentJob"];
  /** Its place in the shift's job list, for its color. */
  jobIndex: number;
  formats: OeeFormats;
}) {
  const { t } = useLingui();
  if (!job) {
    return (
      <Panel label={t`Current job`} title={<Trans>Current job</Trans>}>
        <p className="text-[1.15em] text-white/55">
          <Trans>No job is loaded on this work center</Trans>
        </p>
      </Panel>
    );
  }

  const fill = JOB_FILLS[Math.max(0, jobIndex) % JOB_FILLS.length];
  const progress =
    job.plannedQuantity && job.plannedQuantity > 0
      ? job.completeQuantity / job.plannedQuantity
      : null;
  const good = job.shiftPieces - Math.min(job.shiftBad, job.shiftPieces);

  return (
    <Panel
      label={t`Current job`}
      title={<Trans>Current job</Trans>}
      aside={job.operationDescription}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-[0.6em]">
        <span className="flex min-w-0 items-center gap-[0.4em] text-[1.15em] font-semibold">
          <i
            className={cn(
              "inline-block size-[0.7em] shrink-0 rounded-sm",
              fill
            )}
          />
          <span className="truncate">
            {[job.jobReadableId, job.itemReadableId, job.itemName]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <span className="text-[0.85em] text-white/55">
          {job.idealSecondsPerPiece === null ? (
            <Trans>No standard time</Trans>
          ) : (
            <Trans>
              Standard {formats.seconds(job.idealSecondsPerPiece)} per piece
            </Trans>
          )}
        </span>
      </div>
      <Bar
        value={progress ?? 0}
        fill={fill}
        className="mb-[0.2em] mt-[0.35em] h-[0.8em]"
      />
      <div className="mt-[0.4em] grid grid-cols-2 gap-[0.6em] min-[1100px]:grid-cols-4">
        <Figure label={<Trans>Done / planned</Trans>}>
          {formats.pieces(job.completeQuantity)}{" "}
          <small className="text-[0.55em] font-medium text-white/55">
            /{" "}
            {job.plannedQuantity === null
              ? "—"
              : formats.pieces(job.plannedQuantity)}
            {progress === null ? "" : ` (${formats.ratio(progress)})`}
          </small>
        </Figure>
        <Figure label={<Trans>Good / scrap (this shift)</Trans>}>
          {formats.pieces(good)}{" "}
          <small className="text-[0.55em] font-medium text-white/55">/ </small>
          <span className="text-red-400">{formats.pieces(job.shiftBad)}</span>
        </Figure>
        <Figure
          label={<Trans>Expected finish</Trans>}
          className={job.etaAfterShift ? "text-amber-300" : undefined}
        >
          {job.eta === null ? "—" : formats.clock(job.eta)}
          {job.etaAfterShift ? (
            <small className="ml-[0.3em] text-[0.55em] font-medium">
              <Trans>(after this shift)</Trans>
            </small>
          ) : null}
        </Figure>
        <Figure
          label={<Trans>Job OEE (this shift)</Trans>}
          className={TONE_TEXT[oeeTone(job.oee)]}
        >
          {formats.ratio(job.oee)}
        </Figure>
      </div>
    </Panel>
  );
}

function Figure({
  label,
  className,
  children
}: {
  label: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[0.82em] text-white/55">{label}</div>
      <div
        className={cn(
          "truncate text-[1.7em] font-semibold leading-[1.05] tabular-nums",
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}
