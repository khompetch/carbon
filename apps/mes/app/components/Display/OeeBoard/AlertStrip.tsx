// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { cn } from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { OeeBoardAlert } from "~/utils/display";
import type { OeeFormats } from "./format";

const SEVERITY_STYLE: Record<OeeBoardAlert["severity"], string> = {
  danger: "bg-red-950 text-red-300",
  warn: "bg-amber-950 text-amber-300",
  info: "bg-sky-950 text-sky-300"
};

/** Zone 10: at most 4 alerts, the most severe first. */
export function AlertStrip({
  alerts,
  now,
  formats
}: {
  alerts: OeeBoardAlert[];
  now: number;
  formats: OeeFormats;
}) {
  const { t } = useLingui();
  const text = (alert: OeeBoardAlert): string => {
    switch (alert.kind) {
      case "Down": {
        const length = formats.minutes(now - alert.since);
        return t`Machine down for ${length}`;
      }
      case "Offline": {
        const length = formats.minutes(now - alert.since);
        return t`Machine offline for ${length}`;
      }
      case "Blocked": {
        const dispatch = alert.dispatch;
        return dispatch
          ? t`Blocked by maintenance ${dispatch}`
          : t`Blocked by maintenance`;
      }
      case "JobOeeLow": {
        const job = alert.job ?? t`The job`;
        const oee = formats.ratio(alert.oee);
        return t`${job} OEE ${oee} is below the limit`;
      }
      case "SpeedHigh": {
        const performance = formats.ratio(alert.performance);
        return t`Performance ${performance}: a standard time may be set too slow`;
      }
      case "JobFinishing": {
        const job = alert.job ?? t`The job`;
        const at = formats.clock(alert.at);
        const next = alert.next;
        return next
          ? t`${job} ends about ${at}, get ${next} ready`
          : t`${job} ends about ${at}`;
      }
    }
  };
  return (
    <footer
      aria-live="polite"
      className="flex shrink-0 flex-wrap items-center gap-[0.5em] rounded-[10px] border border-white/10 bg-zinc-900 px-[1em] py-[0.6em]"
    >
      <span className="text-[0.85em] text-white/55">
        <Trans>Alerts</Trans>
      </span>
      {alerts.length === 0 ? (
        <span className="rounded-md bg-emerald-950 px-[0.8em] py-[0.3em] text-[0.9em] font-medium text-emerald-300">
          <Trans>All within limits</Trans>
        </span>
      ) : (
        alerts.map((alert) => (
          <span
            key={alert.kind}
            className={cn(
              "rounded-md px-[0.8em] py-[0.3em] text-[0.9em] font-medium",
              SEVERITY_STYLE[alert.severity]
            )}
          >
            {text(alert)}
          </span>
        ))
      )}
    </footer>
  );
}
