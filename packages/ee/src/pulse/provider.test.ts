// SPDX-License-Identifier: LicenseRef-Carbon-Commercial
// Carbon Enterprise file, licensed only under the Carbon Commercial License
// (packages/ee/LICENSE). Not AGPL. Running, modifying, or copying it beyond those terms requires a commercial license.

import { describe, expect, it } from "vitest";
import { ingestHealth, silentDeviceChange } from "./provider";

// A device last heard from at 10:00:00, Offline after 300 s.
function device(overrides: Partial<Parameters<typeof silentDeviceChange>[0]>) {
  return {
    id: "pdv1",
    lastSeenAt: "2026-11-14T10:00:00.000Z",
    offlineAfterSeconds: 300,
    currentState: "Running" as const,
    currentStateAt: "2026-11-14T09:30:00.000Z",
    now: "2026-11-14T10:06:00.000Z",
    ...overrides
  };
}

describe("silentDeviceChange", () => {
  it("goes Offline at the last message once the device is silent too long", () => {
    expect(silentDeviceChange(device({}))).toEqual({
      // 2026-11-14T10:00:00Z in epoch milliseconds.
      externalEventId: "offline:pdv1:1794650400000",
      state: "Offline",
      changedAt: "2026-11-14T10:00:00.000Z"
    });
  });

  it("returns nothing while the device is inside its offline window", () => {
    expect(
      silentDeviceChange(device({ now: "2026-11-14T10:04:59.000Z" }))
    ).toBeNull();
  });

  it("returns nothing when the newest state is already Offline", () => {
    expect(silentDeviceChange(device({ currentState: "Offline" }))).toBeNull();
  });

  it("returns nothing for a device that never sent a message", () => {
    expect(
      silentDeviceChange(
        device({ lastSeenAt: null, currentState: null, currentStateAt: null })
      )
    ).toBeNull();
  });

  it("never dates the change at or before the state it replaces", () => {
    // The state changed after the last message (clocks disagree).
    const change = silentDeviceChange(
      device({ currentStateAt: "2026-11-14T10:00:30.000Z" })
    );
    expect(change?.changedAt).toBe("2026-11-14T10:00:30.001Z");
  });

  it("names the same change the same way on every sync", () => {
    const first = silentDeviceChange(device({}));
    const later = silentDeviceChange(
      device({ now: "2026-11-14T11:00:00.000Z" })
    );
    expect(later?.externalEventId).toBe(first?.externalEventId);
  });
});

describe("ingestHealth", () => {
  const now = "2026-11-14T10:00:00.000Z";

  it("is healthy within two minutes of the last heartbeat", () => {
    expect(ingestHealth("2026-11-14T09:58:30.000Z", now)).toEqual({
      valid: true
    });
  });

  it("is unhealthy when the heartbeat is older than two minutes", () => {
    expect(ingestHealth("2026-11-14T09:57:59.000Z", now).valid).toBe(false);
  });

  it("is unhealthy when the ingest service never reported", () => {
    expect(ingestHealth(null, now).valid).toBe(false);
  });
});
