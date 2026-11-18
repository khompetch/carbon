// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import {
  OEE_GOOD,
  type OeeBoard,
  oeeTone,
  RATIO_GOOD,
  RATIO_LOW,
  ratioTone
} from "@carbon/planning/oee";
import { cn } from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { OeeFormats } from "./format";
import { TONE_FILL, TONE_TEXT } from "./format";
import { Bar, Panel } from "./Panel";

/** Zone 2: the shift's OEE, large, over Availability, Performance and Quality. */
export function OeeSummary({
  board,
  previousShiftOee,
  formats
}: {
  board: OeeBoard;
  previousShiftOee: number | null;
  formats: OeeFormats;
}) {
  const { t } = useLingui();
  const { parts, ratios } = board;
  const good = parts.totalPieces - Math.min(parts.badPieces, parts.totalPieces);
  const tone = oeeTone(board.oee);
  const target = formats.ratio(OEE_GOOD);
  const previous = formats.ratio(previousShiftOee);

  return (
    <Panel
      label={t`OEE`}
      className="flex flex-col justify-between gap-[0.6em]"
      title={<Trans>OEE this shift (all jobs)</Trans>}
      aside={
        previousShiftOee === null ? (
          <Trans>Target {target}</Trans>
        ) : (
          <Trans>
            Target {target}, last shift {previous}
          </Trans>
        )
      }
    >
      <div
        className={cn(
          "font-semibold leading-[0.9] tabular-nums",
          TONE_TEXT[tone]
        )}
        style={{ fontSize: "clamp(72px, 7.4vw, 190px)" }}
      >
        {formats.ratio(board.oee)}
      </div>
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-[0.7em] gap-y-[0.35em]">
        <RatioRow
          letter="A"
          name={t`Availability`}
          value={ratios.availability}
          formats={formats}
          note={t`Ran ${formats.minutes(parts.runMs)} of ${formats.minutes(parts.plannedMs)} planned`}
        />
        <RatioRow
          letter="P"
          name={t`Performance`}
          value={ratios.performance}
          formats={formats}
          note={t`Standard time made ${formats.minutes(parts.idealMs)} in ${formats.minutes(parts.runWithStandardMs)} of run`}
        />
        <RatioRow
          letter="Q"
          name={t`Quality`}
          value={ratios.quality}
          formats={formats}
          note={t`${formats.pieces(good)} good of ${formats.pieces(parts.totalPieces)} pieces`}
        />
      </div>
    </Panel>
  );
}

function RatioRow({
  letter,
  name,
  value,
  note,
  formats
}: {
  letter: string;
  name: string;
  value: number | null;
  note: string;
  formats: OeeFormats;
}) {
  const tone = ratioTone(value, RATIO_GOOD, RATIO_LOW);
  // Above 100% (a standard set too slow) shows as 100%; the alert says why.
  const shown = value === null ? null : Math.min(1, value);
  return (
    <>
      <span className="font-semibold">
        {letter}{" "}
        <span className="text-[0.85em] font-normal text-white/55">{name}</span>
      </span>
      <Bar value={shown ?? 0} fill={TONE_FILL[tone]} />
      <span className="text-right text-[1.6em] font-semibold leading-none tabular-nums">
        {formats.ratio(shown)}
      </span>
      <span className="col-span-3 -mt-[0.2em] mb-[0.25em] text-[0.78em] text-white/55">
        {note}
      </span>
    </>
  );
}
