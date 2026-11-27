// SPDX-License-Identifier: LicenseRef-Carbon-Commercial
// Carbon Enterprise file, licensed only under the Carbon Commercial License
// (packages/ee/LICENSE). Not AGPL. Running, modifying, or copying it beyond those terms requires a commercial license.

import { RoundingMode, round } from "@carbon/utils";
import type { BlockPeriod, LoadPeriod } from "./engine";

/**
 * Which operation gets a device's counted pieces. Pure: no database, no env.
 *
 * A device sends buckets of sensor pulses (one per machine cycle) and Log
 * scrap presses (one per bad stroke). Each bucket goes to the load that covers
 * the middle of its period, with the same rules as machine time: a bucket
 * while maintenance blocks the work center, with no load, or on an operation
 * that can no longer take quantities goes to the Unattributed Counts queue.
 *
 * Per operation, Log completed is the pulses less the presses, and Log scrap
 * is the presses. A press can come after its stroke was already posted (an
 * earlier sync): those presses lower the posted Production instead
 * (`reclassify`). Every quantity is in pieces: pulses × `piecesPerPulse`.
 *
 * Instants are compared with `Date.parse`: they are absolute UTC instants,
 * the narrow exception in `.claude/rules/date-handling.md`.
 */

export type CountBucket = {
  periodStart: string;
  periodEnd: string;
  pulses: number;
  scrapPulses: number;
};

export type CountTracking = "None" | "Serial" | "Batch";

export type CountOperation = {
  jobOperationId: string;
  tracking: CountTracking;
};

export type PlanMachineCountsInput = {
  /** Ordered by `periodStart`. */
  buckets: CountBucket[];
  loads: LoadPeriod[];
  blocks: BlockPeriod[];
  /** The tracking of each loaded operation. */
  operations: CountOperation[];
  piecesPerPulse: number;
  /** The device sends each pulse at once: required for serial units. */
  sendEachPulse: boolean;
  /** The mapping has a scrap reason for the Log scrap push switch. */
  hasScrapReason: boolean;
};

export type PlannedPosting = {
  jobOperationId: string;
  type: "Production" | "Scrap";
  /** Pieces. A serial posting is always 1. */
  quantity: number;
  /** A Log scrap that lowers Production already posted. */
  reclassify: boolean;
  periodStart: string;
  periodEnd: string;
};

export type UnattributedCountReason =
  | "NoLoad"
  | "Blocked"
  | "OperationClosed"
  | "SerialNeedsSendEachPulse"
  | "NoScrapReason";

export type PlannedUnattributed = {
  periodStart: string;
  periodEnd: string;
  /** Pieces. */
  quantity: number;
  scrapQuantity: number;
  reason: UnattributedCountReason;
  /** The operation the pieces were meant for, when there was one. */
  jobOperationId: string | null;
};

export type MachineCountPlan = {
  postings: PlannedPosting[];
  unattributed: PlannedUnattributed[];
};

const at = (iso: string) => Date.parse(iso);

/** The middle of a bucket's period, in epoch milliseconds. */
function midpoint(bucket: CountBucket): number {
  const start = at(bucket.periodStart);
  return (
    start + round((at(bucket.periodEnd) - start) / 2, 0, RoundingMode.Down)
  );
}

/** Whether `instant` is in `[from, to)`, as `contains` in `engine.ts`. */
const contains = (
  period: { from: string; to: string | null },
  instant: number
) =>
  at(period.from) <= instant && (period.to === null || instant < at(period.to));

type Owner =
  | { kind: "operation"; jobOperationId: string; tracking: CountTracking }
  | {
      kind: "unattributed";
      reason: UnattributedCountReason;
      jobOperationId: string | null;
    };

function ownerOf(
  bucket: CountBucket,
  input: PlanMachineCountsInput,
  tracking: Map<string, CountTracking>
): Owner {
  const instant = midpoint(bucket);
  if (input.blocks.some((block) => contains(block, instant))) {
    return { kind: "unattributed", reason: "Blocked", jobOperationId: null };
  }
  const load = input.loads.find((period) => contains(period, instant));
  if (!load) {
    return { kind: "unattributed", reason: "NoLoad", jobOperationId: null };
  }
  if (!load.assignable) {
    return {
      kind: "unattributed",
      reason: "OperationClosed",
      jobOperationId: load.jobOperationId
    };
  }
  const operationTracking = tracking.get(load.jobOperationId) ?? "None";
  if (operationTracking === "Serial" && !input.sendEachPulse) {
    return {
      kind: "unattributed",
      reason: "SerialNeedsSendEachPulse",
      jobOperationId: load.jobOperationId
    };
  }
  return {
    kind: "operation",
    jobOperationId: load.jobOperationId,
    tracking: operationTracking
  };
}

type Group = {
  jobOperationId: string;
  tracking: CountTracking;
  pulses: number;
  scrapPulses: number;
  periodStart: string;
  periodEnd: string;
};

/** One posting per piece for a serial unit, else one posting. */
function postingsOf(
  group: Group,
  type: PlannedPosting["type"],
  quantity: number,
  reclassify: boolean
): PlannedPosting[] {
  if (quantity <= 0) return [];
  const posting = {
    jobOperationId: group.jobOperationId,
    type,
    reclassify,
    periodStart: group.periodStart,
    periodEnd: group.periodEnd
  };
  if (group.tracking === "Serial") {
    return Array.from({ length: quantity }, () => ({
      ...posting,
      quantity: 1
    }));
  }
  return [{ ...posting, quantity }];
}

export function planMachineCounts(
  input: PlanMachineCountsInput
): MachineCountPlan {
  const tracking = new Map(
    input.operations.map((operation) => [
      operation.jobOperationId,
      operation.tracking
    ])
  );
  const pieces = (pulses: number) => pulses * input.piecesPerPulse;

  const groups = new Map<string, Group>();
  const unattributed: PlannedUnattributed[] = [];

  const addUnattributed = (row: PlannedUnattributed) => {
    if (row.quantity + row.scrapQuantity <= 0) return;
    const last = unattributed.at(-1);
    if (
      last &&
      last.reason === row.reason &&
      last.jobOperationId === row.jobOperationId
    ) {
      last.periodEnd = row.periodEnd;
      last.quantity += row.quantity;
      last.scrapQuantity += row.scrapQuantity;
      return;
    }
    unattributed.push({ ...row });
  };

  for (const bucket of input.buckets) {
    const owner = ownerOf(bucket, input, tracking);
    if (owner.kind === "unattributed") {
      addUnattributed({
        periodStart: bucket.periodStart,
        periodEnd: bucket.periodEnd,
        quantity: pieces(bucket.pulses),
        scrapQuantity: pieces(bucket.scrapPulses),
        reason: owner.reason,
        jobOperationId: owner.jobOperationId
      });
      continue;
    }
    const group = groups.get(owner.jobOperationId);
    if (group) {
      group.pulses += bucket.pulses;
      group.scrapPulses += bucket.scrapPulses;
      group.periodEnd = bucket.periodEnd;
    } else {
      groups.set(owner.jobOperationId, {
        jobOperationId: owner.jobOperationId,
        tracking: owner.tracking,
        pulses: bucket.pulses,
        scrapPulses: bucket.scrapPulses,
        periodStart: bucket.periodStart,
        periodEnd: bucket.periodEnd
      });
    }
  }

  const postings: PlannedPosting[] = [];
  for (const group of groups.values()) {
    const { pulses: p, scrapPulses: s } = group;
    postings.push(
      ...postingsOf(group, "Production", pieces(Math.max(0, p - s)), false)
    );
    const inBatchScrap = pieces(Math.min(p, s));
    const reclassifyScrap = pieces(Math.max(0, s - p));
    if (!input.hasScrapReason) {
      addUnattributed({
        periodStart: group.periodStart,
        periodEnd: group.periodEnd,
        quantity: 0,
        scrapQuantity: inBatchScrap + reclassifyScrap,
        reason: "NoScrapReason",
        jobOperationId: group.jobOperationId
      });
      continue;
    }
    postings.push(
      ...postingsOf(group, "Scrap", inBatchScrap, false),
      ...postingsOf(group, "Scrap", reclassifyScrap, true)
    );
  }

  return { postings, unattributed };
}
