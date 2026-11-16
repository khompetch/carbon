// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { z } from "zod";

/**
 * The ingest service's settings, from the environment. The database
 * connection itself comes from `SUPABASE_DB_URL`, which the shared pool of
 * `@carbon/database/client` reads.
 */
const envSchema = z.object({
  SUPABASE_DB_URL: z.string().min(1),
  MQTT_URL: z.string().min(1).default("mqtt://mosquitto:1883"),
  MQTT_USERNAME: z.string().optional(),
  MQTT_PASSWORD: z.string().optional(),
  MQTT_CLIENT_ID: z.string().min(1).default("carbon-pulse-ingest"),
  INNGEST_BASE_URL: z.string().min(1).default("http://inngest:8288"),
  INNGEST_EVENT_KEY: z.string().min(1),
  /** How often devices are checked for Idle and Offline. */
  PULSE_TICK_SECONDS: z.coerce.number().int().positive().default(5),
  /** How often the device list is read again for new or changed devices. */
  PULSE_RELOAD_SECONDS: z.coerce.number().int().positive().default(60),
  /** How often the ingest service writes its own heartbeat. */
  PULSE_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(30)
});

export type IngestConfig = z.infer<typeof envSchema>;

export function readConfig(env: NodeJS.ProcessEnv = process.env): IngestConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`pulse-ingest: missing or invalid settings: ${fields}`);
  }
  return parsed.data;
}
