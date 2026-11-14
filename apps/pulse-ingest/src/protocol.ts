// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { z } from "zod";

/**
 * The MQTT contract between a Pulse device and the ingest service, version 1.
 *
 *   carbon/pulse/v1/{deviceKey}/count   device → server, QoS 1, only when n > 0
 *   carbon/pulse/v1/{deviceKey}/status  device → server, QoS 1, the heartbeat
 *   carbon/pulse/v1/{deviceKey}/boot    device → server, QoS 1, once per power-up
 *   carbon/pulse/v1/{deviceKey}/online  retained; Last Will "0", "1" on connect
 *   carbon/pulse/v1/{deviceKey}/config  server → device, retained
 *
 * Every instant is epoch milliseconds. `m` values are the device's monotonic
 * clock, which keeps counting when the wall clock is not synchronized.
 */

export const TOPIC_PREFIX = "carbon/pulse/v1";

export const PULSE_CHANNELS = [
  "count",
  "status",
  "boot",
  "online",
  "config"
] as const;

export type PulseChannel = (typeof PULSE_CHANNELS)[number];

const epochMs = z.number().int().nonnegative();
const counter = z.number().int().nonnegative();

/** Pulses counted in one bucket. `seq` only increases within one `boot`. */
export const countPayloadSchema = z.object({
  v: z.literal(1),
  boot: z.string().min(1).max(64),
  seq: z.number().int().nonnegative(),
  /** Bucket start and end on the device's wall clock. */
  t0: epochMs,
  t1: epochMs,
  /** Monotonic clock at the bucket end. */
  m1: epochMs,
  /** Pulses in this bucket. */
  n: z.number().int().positive(),
  /** Lifetime pulse counter after this bucket. */
  total: counter,
  /** False until the device has synchronized its wall clock. */
  tsOk: z.boolean()
});

export type CountPayload = z.infer<typeof countPayloadSchema>;

/** The heartbeat. It proves the device is alive when no pulse arrives. */
export const statusPayloadSchema = z.object({
  v: z.literal(1),
  boot: z.string().min(1).max(64),
  ts: epochMs,
  m: epochMs,
  total: counter,
  rssi: z.number().int().nullish(),
  heap: z.number().int().nullish(),
  fw: z.string().max(32).nullish(),
  /** Buckets the device still holds because they were not acknowledged. */
  queue: z.number().int().nonnegative().default(0),
  tsOk: z.boolean()
});

export type StatusPayload = z.infer<typeof statusPayloadSchema>;

export const bootPayloadSchema = z.object({
  v: z.literal(1).optional(),
  boot: z.string().min(1).max(64),
  fw: z.string().max(32).nullish(),
  reset: z.string().max(32).nullish(),
  totalAtBoot: counter
});

export type BootPayload = z.infer<typeof bootPayloadSchema>;

/** What the server publishes, retained, for a device to apply. */
export type ConfigPayload = {
  debounceMs: number;
  minWidthMs: number;
  bucketSeconds: number;
  heartbeatSeconds: number;
};

/**
 * A device key is the MQTT username and the topic segment, so it must not
 * contain a topic separator or a wildcard.
 */
const DEVICE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isDeviceKey(value: string): boolean {
  return DEVICE_KEY.test(value);
}

export function parseTopic(
  topic: string
): { deviceKey: string; channel: PulseChannel } | null {
  if (!topic.startsWith(`${TOPIC_PREFIX}/`)) return null;
  const rest = topic.slice(TOPIC_PREFIX.length + 1).split("/");
  if (rest.length !== 2) return null;
  const [deviceKey, channel] = rest as [string, string];
  if (!isDeviceKey(deviceKey)) return null;
  if (!(PULSE_CHANNELS as readonly string[]).includes(channel)) return null;
  return { deviceKey, channel: channel as PulseChannel };
}

export function topicFor(deviceKey: string, channel: PulseChannel): string {
  return `${TOPIC_PREFIX}/${deviceKey}/${channel}`;
}

/** The subscription that receives every device's messages on one channel. */
export function subscriptionFor(channel: PulseChannel): string {
  return `${TOPIC_PREFIX}/+/${channel}`;
}

/** Parses a JSON payload. A malformed message returns null, never throws. */
export function parsePayload<T>(
  schema: z.ZodType<T>,
  raw: string | Uint8Array
): T | null {
  try {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
