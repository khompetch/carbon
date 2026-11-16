// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

/**
 * Machine state from pulses alone. A Pulse device has one signal, a pulse per
 * machine cycle, so the state is inferred:
 *
 * - Running: pulses arrive.
 * - Idle: the device is alive (its heartbeat arrives) and no pulse came for
 *   `idleAfter`. The heartbeat must also show a counter that did not move,
 *   or the pulses are only late.
 * - Offline: no message for `offlineAfter`. Nothing is known about the
 *   machine, so no run time is invented.
 *
 * Down is not inferred: it comes from a maintenance dispatch.
 *
 * The functions are pure. Every instant is epoch milliseconds, and the
 * changes of one device always have increasing `changedAt`.
 */

export type InferredState = "Running" | "Idle" | "Offline";

export type StateChangeReason = "pulse" | "idle" | "heartbeat";

export type StateChange = {
  state: InferredState;
  changedAt: number;
  reason: StateChangeReason;
};

export type DeviceTiming = {
  /** The time one machine cycle should take. Null when not configured. */
  expectedCycleSeconds: number | null;
  /** Null means 3 expected cycles, and never less than the minimum. */
  idleAfterSeconds: number | null;
  offlineAfterSeconds: number;
};

export type DeviceTracking = {
  state: InferredState | null;
  /** When the current state began. Null before the first change. */
  stateAt: number | null;
  /** The end of the newest bucket with pulses. */
  lastPulseAt: number | null;
  /** When the server last received any message from the device. */
  lastSeenAt: number | null;
  /** The first message since the device was last Offline or unknown. */
  aliveSince: number | null;
  /** The lifetime counter of the newest stored bucket. */
  lastCounter: number | null;
  /** The lifetime counter the newest heartbeat reported. */
  heartbeatCounter: number | null;
};

export const MINIMUM_IDLE_AFTER_SECONDS = 30;

/**
 * A device that comes back waits this long before it is called Idle, so the
 * buckets it buffered while away can arrive first and make it Running.
 */
export const ALIVE_SETTLE_MS = 10_000;

export const INITIAL_TRACKING: DeviceTracking = {
  state: null,
  stateAt: null,
  lastPulseAt: null,
  lastSeenAt: null,
  aliveSince: null,
  lastCounter: null,
  heartbeatCounter: null
};

export function idleAfterMs(timing: DeviceTiming): number {
  const seconds =
    timing.idleAfterSeconds ??
    (timing.expectedCycleSeconds === null
      ? MINIMUM_IDLE_AFTER_SECONDS
      : timing.expectedCycleSeconds * 3);
  return Math.max(MINIMUM_IDLE_AFTER_SECONDS, seconds) * 1000;
}

function cycleMs(timing: DeviceTiming): number {
  return Math.max(0, (timing.expectedCycleSeconds ?? 0) * 1000);
}

type Step = { tracking: DeviceTracking; changes: StateChange[] };

/** Applies a change, moving its instant forward when it would not be later. */
function change(
  tracking: DeviceTracking,
  state: InferredState,
  at: number,
  reason: StateChangeReason
): { tracking: DeviceTracking; change: StateChange } {
  const changedAt =
    tracking.stateAt === null ? at : Math.max(at, tracking.stateAt + 1);
  return {
    tracking: { ...tracking, state, stateAt: changedAt },
    change: { state, changedAt, reason }
  };
}

function seen(tracking: DeviceTracking, receivedAt: number): DeviceTracking {
  const lastSeenAt = Math.max(tracking.lastSeenAt ?? receivedAt, receivedAt);
  const away = tracking.state === null || tracking.state === "Offline";
  return {
    ...tracking,
    lastSeenAt,
    aliveSince: away ? (tracking.aliveSince ?? receivedAt) : null
  };
}

/** A stored bucket with pulses. `counter` is the lifetime counter after it. */
export function onPulses(
  current: DeviceTracking,
  timing: DeviceTiming,
  bucket: {
    periodStart: number;
    periodEnd: number;
    counter: number;
    receivedAt: number;
  }
): Step {
  let tracking = seen(current, bucket.receivedAt);
  const changes: StateChange[] = [];

  // Buckets replayed after an outage can hold a stop that no tick saw.
  if (
    tracking.state === "Running" &&
    tracking.lastPulseAt !== null &&
    bucket.periodStart - tracking.lastPulseAt >= idleAfterMs(timing)
  ) {
    const idle = change(
      tracking,
      "Idle",
      tracking.lastPulseAt + cycleMs(timing),
      "idle"
    );
    tracking = idle.tracking;
    changes.push(idle.change);
  }

  if (tracking.state !== "Running") {
    const running = change(tracking, "Running", bucket.periodStart, "pulse");
    tracking = running.tracking;
    changes.push(running.change);
  }

  return {
    tracking: {
      ...tracking,
      aliveSince: null,
      lastPulseAt: Math.max(tracking.lastPulseAt ?? 0, bucket.periodEnd),
      lastCounter: Math.max(tracking.lastCounter ?? 0, bucket.counter)
    },
    changes
  };
}

/** A heartbeat. It changes no state by itself: the next tick decides. */
export function onHeartbeat(
  current: DeviceTracking,
  heartbeat: { receivedAt: number; counter: number }
): DeviceTracking {
  return {
    ...seen(current, heartbeat.receivedAt),
    heartbeatCounter: heartbeat.counter
  };
}

/** The periodic check, with the server clock at `now`. */
export function onTick(
  current: DeviceTracking,
  timing: DeviceTiming,
  now: number
): Step {
  const { lastSeenAt } = current;
  if (lastSeenAt === null) return { tracking: current, changes: [] };

  const silent = now - lastSeenAt >= timing.offlineAfterSeconds * 1000;

  if (silent) {
    if (current.state === null || current.state === "Offline") {
      return { tracking: { ...current, aliveSince: null }, changes: [] };
    }
    const offline = change(current, "Offline", lastSeenAt, "heartbeat");
    return {
      tracking: { ...offline.tracking, aliveSince: null },
      changes: [offline.change]
    };
  }

  // Pulses the device counted but the server has not stored are only late.
  const pulsesPending =
    current.heartbeatCounter !== null &&
    current.heartbeatCounter > (current.lastCounter ?? 0);

  if (current.state === null || current.state === "Offline") {
    if (
      current.aliveSince === null ||
      pulsesPending ||
      now - current.aliveSince < ALIVE_SETTLE_MS
    ) {
      return { tracking: current, changes: [] };
    }
    const idle = change(current, "Idle", current.aliveSince, "heartbeat");
    return {
      tracking: { ...idle.tracking, aliveSince: null },
      changes: [idle.change]
    };
  }

  if (
    current.state === "Running" &&
    current.lastPulseAt !== null &&
    !pulsesPending &&
    lastSeenAt - current.lastPulseAt >= idleAfterMs(timing)
  ) {
    const idle = change(
      current,
      "Idle",
      current.lastPulseAt + cycleMs(timing),
      "idle"
    );
    return { tracking: idle.tracking, changes: [idle.change] };
  }

  return { tracking: current, changes: [] };
}
