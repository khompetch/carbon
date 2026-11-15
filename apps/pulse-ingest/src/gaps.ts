// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

/**
 * Lost buckets. A device counts every pulse in a lifetime counter (`total`)
 * and sends that counter with each bucket. When the counter moved by more
 * than the bucket's own pulses since the last bucket the server stored, the
 * difference is pulses whose buckets never arrived. They are stored as one
 * estimated bucket, so the count stays right even though their time is not
 * known exactly. Log scrap presses have their own lifetime counter
 * (`scrapTotal`) and are recovered the same way.
 */

export type LastBucket = {
  boot: string;
  seq: number;
  counter: number;
  /** Null when the stored bucket predates the Log scrap counter. */
  scrapCounter: number | null;
};

export type GapResult =
  /** Already stored, or older than what is stored: write nothing. */
  | { kind: "stale" }
  /** Store the bucket; `missing` pulses and `missingScrap` presses were lost before it. */
  | { kind: "store"; missing: number; missingScrap: number };

/**
 * What a lifetime counter says was lost. A counter below the stored one is a
 * device that lost its counter (new hardware, erased storage): nothing can be
 * inferred, so counting starts again from it.
 */
function lost(previous: number | null, total: number, inBucket: number) {
  if (previous === null || total < previous) return 0;
  return Math.max(0, total - inBucket - previous);
}

export function detectGap(
  last: LastBucket | null,
  bucket: {
    boot: string;
    seq: number;
    n: number;
    total: number;
    scrap: number;
    scrapTotal: number;
  }
): GapResult {
  if (!last) return { kind: "store", missing: 0, missingScrap: 0 };

  if (bucket.boot === last.boot && bucket.seq <= last.seq) {
    return { kind: "stale" };
  }

  return {
    kind: "store",
    missing: lost(last.counter, bucket.total, bucket.n),
    missingScrap: lost(last.scrapCounter, bucket.scrapTotal, bucket.scrap)
  };
}
