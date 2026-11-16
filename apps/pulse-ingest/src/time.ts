// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

/**
 * When a bucket happened, on the server's clock.
 *
 * A device buffers buckets while the network is down, so a bucket can arrive
 * long after it ended: an old `t1` is normal and is trusted. Two cases are not
 * trusted:
 *
 * - `tsOk` is false. The device has not synchronized its wall clock, so `t0`
 *   and `t1` are wrong, but their difference and the monotonic clock are
 *   right. The bucket is placed from a monotonic anchor of the same boot.
 * - `t1` is in the future by more than the tolerance. The device clock is
 *   wrong; the bucket ends when it was received.
 */

/** A device clock this far ahead of the server is wrong, not drifting. */
export const FUTURE_TOLERANCE_MS = 120_000;

/**
 * One instant known on both clocks: the device's monotonic clock read `m`
 * when the server clock read `at`. Valid for one `boot` only.
 */
export type MonotonicAnchor = { boot: string; m: number; at: number };

export type BucketTimes = {
  periodStart: number;
  periodEnd: number;
  /** True when the device's wall clock was not used. */
  rebased: boolean;
};

export function resolveBucketTimes(args: {
  boot: string;
  t0: number;
  t1: number;
  m1: number;
  tsOk: boolean;
  receivedAt: number;
  anchor: MonotonicAnchor | null;
}): BucketTimes {
  const { boot, t0, t1, m1, tsOk, receivedAt, anchor } = args;
  const duration = Math.max(0, t1 - t0);

  if (tsOk && t1 <= receivedAt + FUTURE_TOLERANCE_MS) {
    // A small lead is drift: do not let a bucket end after it arrived.
    const periodEnd = Math.min(t1, receivedAt);
    return { periodStart: periodEnd - duration, periodEnd, rebased: false };
  }

  // The age of the bucket on the monotonic clock, when an anchor of this boot
  // is at or after it. Without one the bucket ends when it was received.
  const age =
    anchor && anchor.boot === boot && anchor.m >= m1 ? anchor.m - m1 : null;
  const periodEnd =
    age === null ? receivedAt : Math.min(anchor!.at - age, receivedAt);
  return { periodStart: periodEnd - duration, periodEnd, rebased: true };
}

/**
 * Keeps the newest anchor of the current boot. A message from a new boot
 * replaces the anchor, because a monotonic clock restarts at power-up.
 */
export function nextAnchor(
  current: MonotonicAnchor | null,
  seen: MonotonicAnchor
): MonotonicAnchor {
  if (!current || current.boot !== seen.boot) return seen;
  return seen.m >= current.m ? seen : current;
}
