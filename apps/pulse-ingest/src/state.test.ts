// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { describe, expect, it } from "vitest";
import {
  ALIVE_SETTLE_MS,
  type DeviceTiming,
  type DeviceTracking,
  INITIAL_TRACKING,
  idleAfterMs,
  onHeartbeat,
  onPulses,
  onTick
} from "./state";

const S = 1000;
const T0 = 1_763_100_000_000;

// A 2 s cycle: Idle after 30 s (the minimum), Offline after 300 s.
const timing: DeviceTiming = {
  expectedCycleSeconds: 2,
  idleAfterSeconds: null,
  offlineAfterSeconds: 300
};

function bucket(startS: number, counter: number, receivedS = startS + 5) {
  return {
    periodStart: T0 + startS * S,
    periodEnd: T0 + (startS + 5) * S,
    counter,
    receivedAt: T0 + receivedS * S
  };
}

function running(): DeviceTracking {
  return onPulses(INITIAL_TRACKING, timing, bucket(0, 3)).tracking;
}

describe("idleAfterMs", () => {
  it("is 3 expected cycles, and never less than 30 s", () => {
    expect(idleAfterMs(timing)).toBe(30 * S);
    expect(idleAfterMs({ ...timing, expectedCycleSeconds: 20 })).toBe(60 * S);
    expect(idleAfterMs({ ...timing, expectedCycleSeconds: null })).toBe(30 * S);
  });

  it("uses the configured value when there is one", () => {
    expect(idleAfterMs({ ...timing, idleAfterSeconds: 90 })).toBe(90 * S);
    expect(idleAfterMs({ ...timing, idleAfterSeconds: 5 })).toBe(30 * S);
  });
});

describe("onPulses", () => {
  it("starts Running at the start of the first bucket", () => {
    const { tracking, changes } = onPulses(
      INITIAL_TRACKING,
      timing,
      bucket(0, 3)
    );
    expect(changes).toEqual([
      { state: "Running", changedAt: T0, reason: "pulse" }
    ]);
    expect(tracking.state).toBe("Running");
    expect(tracking.lastPulseAt).toBe(T0 + 5 * S);
    expect(tracking.lastCounter).toBe(3);
  });

  it("changes nothing while pulses keep arriving", () => {
    const { tracking, changes } = onPulses(running(), timing, bucket(5, 6));
    expect(changes).toEqual([]);
    expect(tracking.lastPulseAt).toBe(T0 + 10 * S);
    expect(tracking.lastCounter).toBe(6);
  });

  it("records a stop that only replayed buckets show", () => {
    // Pulses to 0:05, then nothing until 2:00. No tick ran in between.
    const { changes } = onPulses(running(), timing, bucket(120, 6));
    expect(changes).toEqual([
      // One expected cycle after the last pulse.
      { state: "Idle", changedAt: T0 + 7 * S, reason: "idle" },
      { state: "Running", changedAt: T0 + 120 * S, reason: "pulse" }
    ]);
  });
});

describe("onTick", () => {
  it("does nothing for a device that never sent a message", () => {
    expect(onTick(INITIAL_TRACKING, timing, T0)).toEqual({
      tracking: INITIAL_TRACKING,
      changes: []
    });
  });

  it("keeps Running without a heartbeat that proves the stop", () => {
    // 60 s with no message at all: the device may only be unreachable.
    const { changes } = onTick(running(), timing, T0 + 65 * S);
    expect(changes).toEqual([]);
  });

  it("goes Idle when a heartbeat shows the counter did not move", () => {
    const alive = onHeartbeat(running(), {
      receivedAt: T0 + 40 * S,
      counter: 3
    });
    const { tracking, changes } = onTick(alive, timing, T0 + 41 * S);
    expect(changes).toEqual([
      { state: "Idle", changedAt: T0 + 7 * S, reason: "idle" }
    ]);
    expect(tracking.state).toBe("Idle");
  });

  it("stays Running when the heartbeat counter is ahead of the stored one", () => {
    // The device counted 9 pulses; only 3 are stored. The rest are in transit.
    const alive = onHeartbeat(running(), {
      receivedAt: T0 + 40 * S,
      counter: 9
    });
    expect(onTick(alive, timing, T0 + 41 * S).changes).toEqual([]);
  });

  it("goes Offline at the last message when the device is silent", () => {
    const { tracking, changes } = onTick(running(), timing, T0 + 306 * S);
    expect(changes).toEqual([
      { state: "Offline", changedAt: T0 + 5 * S, reason: "heartbeat" }
    ]);
    expect(tracking.state).toBe("Offline");
    // A second tick does not repeat the change.
    expect(onTick(tracking, timing, T0 + 400 * S).changes).toEqual([]);
  });

  it("goes Offline from Idle, after the Idle instant", () => {
    const alive = onHeartbeat(running(), {
      receivedAt: T0 + 40 * S,
      counter: 3
    });
    const idle = onTick(alive, timing, T0 + 41 * S).tracking;
    const { changes } = onTick(idle, timing, T0 + 400 * S);
    expect(changes).toEqual([
      { state: "Offline", changedAt: T0 + 40 * S, reason: "heartbeat" }
    ]);
  });
});

describe("a device that comes back", () => {
  function offline(): DeviceTracking {
    return onTick(running(), timing, T0 + 306 * S).tracking;
  }

  it("is Idle once it has been alive for the settle time with no pulses", () => {
    const back = onHeartbeat(offline(), {
      receivedAt: T0 + 600 * S,
      counter: 3
    });
    // Too early: buffered buckets may still arrive.
    expect(onTick(back, timing, T0 + 601 * S).changes).toEqual([]);

    const { changes } = onTick(back, timing, T0 + 600 * S + ALIVE_SETTLE_MS);
    expect(changes).toEqual([
      { state: "Idle", changedAt: T0 + 600 * S, reason: "heartbeat" }
    ]);
  });

  it("is Running from its buffered buckets, not Idle from its heartbeat", () => {
    // The machine ran while the network was down. The heartbeat arrives
    // first, then the buckets the device kept.
    let tracking = onHeartbeat(offline(), {
      receivedAt: T0 + 600 * S,
      counter: 40
    });
    expect(
      onTick(tracking, timing, T0 + 600 * S + ALIVE_SETTLE_MS).changes
    ).toEqual([]);

    const replay = onPulses(tracking, timing, bucket(320, 40, 601));
    expect(replay.changes).toEqual([
      { state: "Running", changedAt: T0 + 320 * S, reason: "pulse" }
    ]);
    tracking = replay.tracking;
    expect(tracking.aliveSince).toBeNull();
  });

  it("never emits a change at or before the previous one", () => {
    // A bucket that starts before the Offline instant (clock disagreement).
    const tracking = offline();
    const { changes } = onPulses(tracking, timing, bucket(2, 6, 601));
    expect(changes).toEqual([
      { state: "Running", changedAt: T0 + 5 * S + 1, reason: "pulse" }
    ]);
  });

  it("is Idle on its first heartbeat when it has never sent a pulse", () => {
    const first = onHeartbeat(INITIAL_TRACKING, {
      receivedAt: T0,
      counter: 0
    });
    const { changes } = onTick(first, timing, T0 + ALIVE_SETTLE_MS);
    expect(changes).toEqual([
      { state: "Idle", changedAt: T0, reason: "heartbeat" }
    ]);
  });
});
