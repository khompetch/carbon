// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import type { OeeBoardState, OeeTone } from "@carbon/planning/oee";
import { PROGRESS_FORMAT, SCALE_FORMAT } from "@carbon/utils";
import { useLocale } from "@react-aria/i18n";
import { useMemo } from "react";

/** The number and time formats of one board, in the screen's locale. */
export function useOeeFormats(timeZone: string) {
  const { locale } = useLocale();
  return useMemo(() => {
    const percent = new Intl.NumberFormat(locale, PROGRESS_FORMAT);
    const pieces = new Intl.NumberFormat(locale, SCALE_FORMAT);
    const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    const seconds = new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "second",
      unitDisplay: "narrow",
      maximumFractionDigits: 1
    });
    const minutes = new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "minute",
      unitDisplay: "short",
      maximumFractionDigits: 0
    });
    const clock = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone
    });
    const hour = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone
    });
    return {
      /** A ratio, or a dash when there is nothing to divide by. */
      ratio: (value: number | null | undefined) =>
        value === null || value === undefined ? "—" : percent.format(value),
      pieces: (value: number) => pieces.format(value),
      whole: (value: number) => whole.format(value),
      seconds: (value: number | null) =>
        value === null ? "—" : seconds.format(value),
      minutes: (ms: number) => minutes.format(ms / 60_000),
      clock: (at: number) => clock.format(at),
      hour: (at: number) => hour.format(at)
    };
  }, [locale, timeZone]);
}

export type OeeFormats = ReturnType<typeof useOeeFormats>;

export const TONE_TEXT: Record<OeeTone, string> = {
  neutral: "text-white/80",
  good: "text-emerald-400",
  warn: "text-amber-300",
  danger: "text-red-400"
};

export const TONE_FILL: Record<OeeTone, string> = {
  neutral: "bg-white/30",
  good: "bg-emerald-500",
  warn: "bg-amber-400",
  danger: "bg-red-500"
};

export const STATE_FILL: Record<OeeBoardState, string> = {
  Running: "bg-emerald-500",
  Idle: "bg-amber-400",
  Down: "bg-red-500",
  Offline: "bg-zinc-400",
  Unknown: "bg-sky-500",
  NotPlanned: "bg-zinc-700"
};

/** Four job colors in turn, so two jobs side by side never share one. */
export const JOB_FILLS = [
  "bg-blue-600",
  "bg-teal-600",
  "bg-violet-600",
  "bg-orange-700"
] as const;
