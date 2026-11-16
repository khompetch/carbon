// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

/**
 * When the ingest service wakes a device's OEE sync, and with which Inngest
 * event id. Inngest drops a second event with the same id, so the id decides
 * how often the sync runs:
 *
 * - a state change: at most once a minute per device;
 * - a count on a device in count mode Auto, sending buckets: at most once a
 *   minute (the sweep catches the rest within 10 minutes);
 * - a count on a device that sends each pulse at once: once per bucket, so
 *   each completion posts within seconds (and its label prints).
 */

export type WakeReason =
  | { kind: "state" }
  | { kind: "count"; boot: string; seq: number };

export function syncEventId(
  device: { id: string; sendEachPulse: boolean },
  reason: WakeReason,
  now: number
): string {
  const minute = Math.floor(now / 60_000);
  if (reason.kind === "state") return `pulse:${device.id}:${minute}`;
  if (device.sendEachPulse) {
    return `pulse:${device.id}:count:${reason.boot}:${reason.seq}`;
  }
  return `pulse:${device.id}:count:${minute}`;
}

/** A stored bucket wakes the sync only when the sensor posts the counts. */
export function wakesForCounts(device: {
  mapped: boolean;
  countMode: "Off" | "Auto" | null;
}): boolean {
  return device.mapped && device.countMode === "Auto";
}
