// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import type { KyselyDatabase } from "@carbon/database/client";
import { Kysely, PostgresDialect } from "kysely";
import mqtt from "mqtt";
import pg from "pg";
import { readConfig } from "./config";
import { DeviceWorker } from "./device";
import {
  bootPayloadSchema,
  type ConfigPayload,
  countPayloadSchema,
  PULSE_CHANNELS,
  parsePayload,
  parseTopic,
  statusPayloadSchema,
  subscriptionFor,
  topicFor
} from "./protocol";
import { type DeviceRow, loadDevices, writeIngestHeartbeat } from "./store";
import { syncEventId, type WakeReason } from "./wake";

/**
 * The Pulse ingest service: one long-lived MQTT subscriber. It stores what
 * devices send, infers each machine's state, and wakes the OEE sync of a
 * device whose state changed. Run one instance: two would both write.
 */

const VERSION = "1";

const config = readConfig();
// Its own pool, not `@carbon/database/client`'s: that module loads as CJS,
// which named imports cannot read under plain `tsx` (see check-backups.ts).
// Without its type parsers, NUMERIC and BIGINT arrive as strings and
// timestamps as `Date`; `store.ts` converts both.
const pool = new pg.Pool({ connectionString: config.SUPABASE_DB_URL, max: 4 });
const db = new Kysely<KyselyDatabase>({
  dialect: new PostgresDialect({ pool })
});

const log = (message: string, context: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ service: "pulse-ingest", message, ...context }));

/** Sends `carbon/oee-device-sync` straight to Inngest for a mapped device. */
async function wakeSync(device: DeviceRow, reason: WakeReason) {
  if (!device.mapped) return;
  const url = `${config.INNGEST_BASE_URL}/e/${config.INNGEST_EVENT_KEY}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "carbon/oee-device-sync",
        // Inngest drops a repeated id: see `syncEventId`.
        id: syncEventId(device, reason, Date.now()),
        data: {
          companyId: device.companyId,
          integrationId: "pulse",
          externalDeviceId: device.deviceKey
        }
      })
    });
    if (!response.ok) {
      log("could not wake the OEE sync", {
        device: device.deviceKey,
        status: response.status
      });
    }
  } catch (error) {
    // The sweep syncs the device within 10 minutes anyway.
    log("could not reach Inngest", {
      device: device.deviceKey,
      error: String(error)
    });
  }
}

const workers = new Map<string, DeviceWorker>();
const unknown = new Set<string>();

const client = mqtt.connect(config.MQTT_URL, {
  clientId: config.MQTT_CLIENT_ID,
  username: config.MQTT_USERNAME,
  password: config.MQTT_PASSWORD,
  // A persistent session: the broker keeps QoS 1 messages while we are away.
  clean: false,
  reconnectPeriod: 2_000
});

function publishConfig(device: DeviceRow) {
  const payload: ConfigPayload = {
    debounceMs: device.debounceMs,
    minWidthMs: Math.min(device.debounceMs, 5),
    bucketSeconds: device.bucketSeconds,
    heartbeatSeconds: 30,
    sendEachPulse: device.sendEachPulse
  };
  client.publish(topicFor(device.deviceKey, "config"), JSON.stringify(payload), {
    qos: 1,
    retain: true
  });
}

async function reloadDevices() {
  const rows = await loadDevices(db);
  for (const row of rows) {
    const worker = workers.get(row.deviceKey);
    if (worker) {
      const before = worker.device;
      worker.refresh(row);
      if (
        before.debounceMs !== row.debounceMs ||
        before.bucketSeconds !== row.bucketSeconds ||
        before.sendEachPulse !== row.sendEachPulse
      ) {
        publishConfig(row);
      }
    } else {
      workers.set(row.deviceKey, new DeviceWorker(row, db, wakeSync));
      unknown.delete(row.deviceKey);
      publishConfig(row);
    }
  }
  const active = new Set(rows.map((row) => row.deviceKey));
  for (const key of workers.keys()) {
    if (!active.has(key)) workers.delete(key);
  }
}

client.on("connect", () => {
  log("connected to the broker", { url: config.MQTT_URL });
  for (const channel of PULSE_CHANNELS) {
    if (channel === "config") continue;
    client.subscribe(subscriptionFor(channel), { qos: 1 });
  }
});

client.on("error", (error) => log("broker error", { error: String(error) }));

client.on("message", (topic, raw) => {
  const receivedAt = Date.now();
  const parsed = parseTopic(topic);
  if (!parsed) return;
  const worker = workers.get(parsed.deviceKey);
  if (!worker) {
    if (!unknown.has(parsed.deviceKey)) {
      unknown.add(parsed.deviceKey);
      log("message from an unregistered device", {
        device: parsed.deviceKey
      });
    }
    return;
  }

  const fail = (error: unknown) =>
    log("could not store a message", {
      device: parsed.deviceKey,
      channel: parsed.channel,
      error: String(error)
    });

  switch (parsed.channel) {
    case "count": {
      const payload = parsePayload(countPayloadSchema, raw);
      if (payload) worker.count(payload, receivedAt).catch(fail);
      break;
    }
    case "status": {
      const payload = parsePayload(statusPayloadSchema, raw);
      if (payload) worker.status(payload, receivedAt).catch(fail);
      break;
    }
    case "boot": {
      const payload = parsePayload(bootPayloadSchema, raw);
      if (payload) worker.boot(payload, receivedAt).catch(fail);
      break;
    }
    default:
      break;
  }
});

async function start() {
  await reloadDevices();
  await writeIngestHeartbeat(db, VERSION);
  log("started", { devices: workers.size });

  setInterval(() => {
    const now = Date.now();
    for (const worker of workers.values()) {
      worker.tick(now).catch((error) =>
        log("tick failed", {
          device: worker.device.deviceKey,
          error: String(error)
        })
      );
    }
  }, config.PULSE_TICK_SECONDS * 1000);

  setInterval(() => {
    reloadDevices().catch((error) =>
      log("could not reload devices", { error: String(error) })
    );
  }, config.PULSE_RELOAD_SECONDS * 1000);

  setInterval(() => {
    writeIngestHeartbeat(db, VERSION).catch((error) =>
      log("could not write the heartbeat", { error: String(error) })
    );
  }, config.PULSE_HEARTBEAT_SECONDS * 1000);
}

start().catch((error) => {
  log("could not start", { error: String(error) });
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log("stopping", { signal });
    client.end(false, {}, () => process.exit(0));
  });
}
