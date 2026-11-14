// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

/**
 * Lost buckets. A device counts every pulse in a lifetime counter (`total`)
 * and sends that counter with each bucket. When the counter moved by more
 * than the bucket's own pulses since the last bucket the server stored, the
 * difference is pulses whose buckets never arrived. They are stored as one
 * estimated bucket, so the count stays right even though their time is not
 * known exactly.
 */

export type LastBucket = { boot: string; seq: number; counter: number };

export type GapResult =
  /** Already stored, or older than what is stored: write nothing. */
  | { kind: "stale" }
  /** Store the bucket; `missing` pulses were lost before it. */
  | { kind: "store"; missing: number };

export function detectGap(
  last: LastBucket | null,
  bucket: { boot: string; seq: number; n: number; total: number }
): GapResult {
  if (!last) return { kind: "store", missing: 0 };

  if (bucket.boot === last.boot && bucket.seq <= last.seq) {
    return { kind: "stale" };
  }

  // A counter below the stored one is a device that lost its counter (new
  // hardware, erased storage). Nothing can be inferred: start again from it.
  if (bucket.total < last.counter) return { kind: "store", missing: 0 };

  const missing = bucket.total - bucket.n - last.counter;
  return { kind: "store", missing: Math.max(0, missing) };
}
