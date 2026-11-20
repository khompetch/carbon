// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import {
  type Interval,
  intersectWindows,
  intervalLength,
  unionIntervals
} from "./intervals.ts";
import {
  computeOeeParts,
  countOperation,
  type OeeWorkCenterInput
} from "./oee.ts";

/** The loss a stop reason counts toward (enum `oeeLoss`). */
export type OeeLossCategory = "Breakdown" | "Setup & Adjustment" | "Small Stop";

/** One of the Six Big Losses. */
export type SixBigLossKey =
  | "breakdowns"
  | "setupAdjustments"
  | "smallStops"
  | "reducedSpeed"
  | "startupRejects"
  | "productionRejects";

/** The OEE factor a loss takes away from. */
export type SixBigLossFactor = "availability" | "performance" | "quality";

export type SixBigLoss = {
  key: SixBigLossKey;
  factor: SixBigLossFactor;
  /** Minutes for a time loss, pieces for a reject loss; null when unknown. */
  value: number | null;
  unit: "minutes" | "pieces";
};

export type SixBigLossesInput = {
  /** Epoch ms; an open stop or Setup event runs until now. */
  now: number;
  /** The operation's Setup events. */
  setupEvents: { startTime: number; endTime: number | null }[];
  /** The operation's logged stops with their reason's loss. */
  stops: {
    startTime: number;
    endTime: number | null;
    oeeLoss: OeeLossCategory;
  }[];
  /** Scrap and Rework quantities; `duringSetup` when logged while a Setup event ran. */
  rejects: { quantity: number; duringSetup: boolean }[];
  /** Run time with a standard minus ideal time; null when no standard. */
  speedLossMs: number | null;
};

const MINUTE = 60_000;

/** The order the losses are shown in, grouped by factor. */
export const SIX_BIG_LOSS_ORDER: {
  key: SixBigLossKey;
  factor: SixBigLossFactor;
}[] = [
  { key: "breakdowns", factor: "availability" },
  { key: "setupAdjustments", factor: "availability" },
  { key: "smallStops", factor: "performance" },
  { key: "reducedSpeed", factor: "performance" },
  { key: "startupRejects", factor: "quality" },
  { key: "productionRejects", factor: "quality" }
];

function toIntervals(
  rows: { startTime: number; endTime: number | null }[],
  now: number
): Interval[] {
  return rows.map((row) => ({
    start: row.startTime,
    end: row.endTime ?? Math.max(now, row.startTime)
  }));
}

function stopsOf(input: SixBigLossesInput, loss: OeeLossCategory): Interval[] {
  return toIntervals(
    input.stops.filter((stop) => stop.oeeLoss === loss),
    input.now
  );
}

function minutes(ms: number): number {
  return Math.round(ms / MINUTE);
}

/**
 * The Six Big Losses of one operation. Time that two stops (or a stop and a
 * Setup event) both cover counts once inside a loss.
 */
export function computeSixBigLosses(input: SixBigLossesInput): SixBigLoss[] {
  const breakdownMs = intervalLength(stopsOf(input, "Breakdown"));
  const setupMs = intervalLength([
    ...toIntervals(input.setupEvents, input.now),
    ...stopsOf(input, "Setup & Adjustment")
  ]);
  const smallStopMs = intervalLength(stopsOf(input, "Small Stop"));

  let startupRejects = 0;
  let productionRejects = 0;
  for (const reject of input.rejects) {
    if (reject.duringSetup) startupRejects += reject.quantity;
    else productionRejects += reject.quantity;
  }

  const values: Record<SixBigLossKey, number | null> = {
    breakdowns: minutes(breakdownMs),
    setupAdjustments: minutes(setupMs),
    smallStops: minutes(smallStopMs),
    reducedSpeed:
      input.speedLossMs === null
        ? null
        : minutes(Math.max(0, input.speedLossMs)),
    startupRejects,
    productionRejects
  };

  return SIX_BIG_LOSS_ORDER.map(({ key, factor }) => ({
    key,
    factor,
    value: values[key],
    unit: factor === "quality" ? "pieces" : "minutes"
  }));
}

/**
 * The Reduced Speed loss of one operation in ms: the run its Machine events
 * own, with a standard, less the ideal time of its pieces. Null when no part
 * of that run has a standard.
 */
export function operationSpeedLossMs(
  input: OeeWorkCenterInput,
  jobOperationId: string
): number | null {
  const owners = input.owners.filter(
    (owner) => owner.jobOperationId === jobOperationId
  );
  const scoped: OeeWorkCenterInput = {
    ...input,
    runIntervals: intersectWindows(input.runIntervals, unionIntervals(owners)),
    owners,
    counts: input.counts.filter(
      (count) => countOperation(input, count) === jobOperationId
    )
  };
  const parts = computeOeeParts(scoped);
  if (parts.runWithStandardMs <= 0) return null;
  return parts.runWithStandardMs - parts.idealMs;
}
