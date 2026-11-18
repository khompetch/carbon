// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import {
  HOURLY_GOOD,
  HOURLY_LOW,
  type OeeBoard,
  ratioTone
} from "@carbon/planning/oee";
import { cn } from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { OeeFormats } from "./format";
import { TONE_FILL } from "./format";
import { Panel } from "./Panel";

/** The bar scale tops out here, so a fast hour still shows its value. */
const SCALE_TOP = 1.1;

/** Zone 5: each hour's standard time made ÷ its planned time. */
export function HourlyBars({
  board,
  formats
}: {
  board: OeeBoard;
  formats: OeeFormats;
}) {
  const { t } = useLingui();
  const target = formats.ratio(HOURLY_GOOD);
  const height = (value: number) =>
    `${(Math.min(SCALE_TOP, value) / SCALE_TOP) * 100}%`;
  return (
    <Panel
      label={t`Hourly efficiency`}
      className="flex min-h-0 flex-col"
      title={<Trans>Hourly efficiency</Trans>}
      aside={
        <Trans>
          Standard time made ÷ planned time, dashed line = {target}, ⇄ = job
          change
        </Trans>
      }
    >
      <div
        className="grid min-h-[8em] flex-1 gap-[0.35em]"
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, board.hourly.length)}, minmax(0, 1fr))`
        }}
      >
        {board.hourly.map((hour) => {
          const value = hour.efficiency;
          const shown = !hour.isFuture && value !== null;
          return (
            <div key={hour.start} className="flex min-h-0 flex-col">
              <div className="relative flex-1 border-b border-white/15">
                {shown ? (
                  <>
                    <div
                      className={cn(
                        "absolute inset-x-[12%] bottom-0 rounded-t transition-[height] duration-500",
                        TONE_FILL[ratioTone(value, HOURLY_GOOD, HOURLY_LOW)]
                      )}
                      style={{ height: height(value) }}
                    />
                    <div
                      className="absolute inset-x-0 text-center text-[0.95em] font-semibold tabular-nums"
                      // The label stays inside the chart when the bar is at the top.
                      style={{
                        bottom: `calc(min(${height(value)}, 100% - 1.3em) + 0.1em)`
                      }}
                    >
                      {formats.whole(value * 100)}
                    </div>
                  </>
                ) : null}
                <div
                  className="absolute inset-x-0 border-t-2 border-dashed border-white/40"
                  style={{ bottom: height(HOURLY_GOOD) }}
                />
              </div>
              <div className="mt-[0.2em] text-center text-[0.75em] text-white/55 tabular-nums">
                {formats.hour(hour.start)}
                {hour.isCurrent ? "*" : ""}
                {hour.jobChange ? " ⇄" : ""}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
