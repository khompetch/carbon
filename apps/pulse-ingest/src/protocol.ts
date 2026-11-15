// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { z } from "zod";

/**
 * The MQTT contract between a Pulse device and the ingest service, version 1.
 *
 *   carbon/pulse/v1/{deviceKey}/count   device → server, QoS 1, when n + scrap > 0
 *   carbon/pulse/v1/{deviceKey}/status  device → server, QoS 1, the heartbeat
 *   carbon/pulse/v1/{deviceKey}/boot    device → server, QoS 1, once per power-up
 *   carbon/pulse/v1/{deviceKey}/online  retained; Last Will "0", "1" on connect
 *   carbon/pulse/v1/{deviceKey}/config  server → device, retained
 *
 * A device has 2 inputs: the cycle sensor (one pulse per machine cycle) and
 * the Log scrap push switch (one press per bad stroke). It sends a `count`
 * bucket:
 *
 * - every `bucketSeconds`, for the pulses of that period (the default);
 * - at once for each pulse, when the config sets `sendEachPulse` (machines
 *   with a long cycle). Pulses less than `SEND_EACH_PULSE_MIN_GAP_MS` apart
 *   still share one bucket;
 * - at once for a Log scrap press, in both modes.
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

/** In send-each-pulse mode, pulses closer than this share one bucket. */
export const SEND_EACH_PULSE_MIN_GAP_MS = 200;

/**
 * Pulses and Log scrap presses counted in one bucket. `seq` only increases
 * within one `boot`. A device without the push switch never sends `scrap`.
 */
export const countPayloadSchema = z
  .object({
    v: z.literal(1),
    boot: z.string().min(1).max(64),
    seq: z.number().int().nonnegative(),
    /** Bucket start and end on the device's wall clock. Equal for one pulse. */
    t0: epochMs,
    t1: epochMs,
    /** Monotonic clock at the bucket end. */
    m1: epochMs,
    /** Sensor pulses in this bucket. */
    n: z.number().int().nonnegative(),
    /** Lifetime pulse counter after this bucket. */
    total: counter,
    /** Log scrap presses in this bucket. */
    scrap: z.number().int().nonnegative().default(0),
    /** Lifetime Log scrap press counter after this bucket. */
    scrapTotal: counter.default(0),
    /** False until the device has synchronized its wall clock. */
    tsOk: z.boolean()
  })
  .refine((bucket) => bucket.n + bucket.scrap > 0, {
    message: "A bucket holds at least one pulse or Log scrap press"
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
  /** Send each pulse at once instead of every `bucketSeconds`. */
  sendEachPulse: boolean;
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
