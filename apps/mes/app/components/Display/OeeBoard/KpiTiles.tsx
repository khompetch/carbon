// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import {
  type OeeBoard,
  type OeeTone,
  RATIO_GOOD,
  RATIO_LOW,
  ratioTone
} from "@carbon/planning/oee";
import { cn } from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { OeeFormats } from "./format";
import { TONE_FILL, TONE_TEXT } from "./format";
import { Panel } from "./Panel";

// A cycle up to 10% over the standard is fine, over 15% needs action.
const CYCLE_GOOD = 1 / 1.1;
const CYCLE_LOW = 1 / 1.15;
// Under full coverage, Performance leaves out the run with no standard.
const COVERAGE_GOOD = 0.99;

type Tile = { label: string; value: string; sub: string; tone: OeeTone };

/**
 * Zone 6: four figures of how the machine runs, from what Carbon records (it
 * reads no process parameters), and the times OEE is made of.
 */
export function KpiTiles({
  board,
  source,
  formats
}: {
  board: OeeBoard;
  source: "Sensor" | "Operator";
  formats: OeeFormats;
}) {
  const { t } = useLingui();
  const { kpis, parts } = board;
  const speed =
    kpis.idealSecondsPerPiece !== null && kpis.actualSecondsPerPiece
      ? kpis.idealSecondsPerPiece / kpis.actualSecondsPerPiece
      : null;
  const ideal = kpis.idealSecondsPerPiece;
  const tiles: Tile[] = [
    {
      label: t`Actual cycle per piece`,
      value: formats.seconds(kpis.actualSecondsPerPiece),
      sub:
        ideal === null
          ? t`No standard time`
          : t`Standard ${formats.seconds(ideal)}`,
      tone: ratioTone(speed, CYCLE_GOOD, CYCLE_LOW)
    },
    {
      label: t`Pieces per run hour`,
      value:
        kpis.piecesPerHour === null ? "—" : formats.whole(kpis.piecesPerHour),
      sub:
        ideal === null
          ? t`No standard time`
          : t`At standard ${formats.whole(3600 / ideal)}`,
      tone: ratioTone(speed, CYCLE_GOOD, CYCLE_LOW)
    },
    {
      label: t`Scrap rate`,
      value: formats.ratio(kpis.scrapRate),
      sub: t`${formats.pieces(parts.badPieces)} of ${formats.pieces(parts.totalPieces)} pieces`,
      tone: ratioTone(
        kpis.scrapRate === null ? null : 1 - kpis.scrapRate,
        RATIO_GOOD,
        RATIO_LOW
      )
    },
    {
      label: t`Run with a standard time`,
      value: formats.ratio(kpis.standardCoverage),
      sub: t`Performance counts only this run`,
      tone: ratioTone(kpis.standardCoverage, COVERAGE_GOOD, RATIO_LOW)
    }
  ];
  const times = [
    { label: <Trans>Planned time</Trans>, ms: parts.plannedMs },
    { label: <Trans>Run time</Trans>, ms: parts.runMs },
    { label: <Trans>Run outside shifts</Trans>, ms: parts.runOutsideMs },
    { label: <Trans>Standard time made</Trans>, ms: parts.idealMs }
  ];

  return (
    <Panel
      label={t`Machine figures`}
      title={<Trans>Machine figures</Trans>}
      aside={
        source === "Sensor" ? (
          <Trans>From the sensor</Trans>
        ) : (
          <Trans>From operator time</Trans>
        )
      }
    >
      <div className="grid grid-cols-2 gap-[0.6em]">
        {tiles.map((tile) => (
          <div
            key={tile.label}
            className="min-w-0 rounded-lg bg-white/5 px-[0.75em] py-[0.6em]"
          >
            <div className="flex items-center gap-[0.4em] text-[0.82em] text-white/55">
              <i
                className={cn(
                  "size-[0.6em] shrink-0 rounded-full",
                  TONE_FILL[tile.tone]
                )}
              />
              <span className="truncate">{tile.label}</span>
            </div>
            <div
              className={cn(
                "truncate text-[2.3em] font-semibold leading-[1.05] tabular-nums",
                tile.tone === "good" || tile.tone === "neutral"
                  ? "text-white"
                  : TONE_TEXT[tile.tone]
              )}
            >
              {tile.value}
            </div>
            <div className="truncate text-[0.78em] text-white/55">
              {tile.sub}
            </div>
          </div>
        ))}
      </div>
      <dl className="mt-[0.7em] grid grid-cols-[1fr_auto] gap-x-[0.8em] gap-y-[0.15em] text-[0.88em]">
        {times.map((row, index) => (
          <div key={index} className="contents">
            <dt className="text-white/55">{row.label}</dt>
            <dd className="text-right text-[1.15em] font-semibold tabular-nums">
              {formats.minutes(row.ms)}
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
