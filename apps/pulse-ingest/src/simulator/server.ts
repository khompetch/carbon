// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import mqtt, { type MqttClient } from "mqtt";
import pg from "pg";
import { isDeviceKey, topicFor } from "../protocol";
import { type SimMessage, SimDevice, type SimSettings } from "./device";

/**
 * The Pulse device simulator, a local development tool. Each simulated
 * device has its own MQTT connection, as a device behind the on-site gateway
 * would, and publishes the same messages as the firmware. A web page drives
 * the devices: http://127.0.0.1:4810 (`pnpm --filter pulse-ingest simulate`).
 *
 *   MQTT_URL               default mqtt://127.0.0.1:1883
 *   MQTT_USERNAME          default pulse-gateway (its ACL covers every device topic)
 *   MQTT_PASSWORD          default MQTT_GATEWAY_PASSWORD
 *   SUPABASE_DB_URL        optional: list the registered devices and show what Carbon inferred
 *   SIMULATOR_PORT         default 4810
 *
 * Never run it against a production broker: its messages are real counts.
 */

const MQTT_URL = process.env.MQTT_URL ?? "mqtt://127.0.0.1:1883";
const MQTT_USERNAME = process.env.MQTT_USERNAME ?? "pulse-gateway";
const MQTT_PASSWORD =
  process.env.MQTT_PASSWORD ?? process.env.MQTT_GATEWAY_PASSWORD;
const PORT = Number(process.env.SIMULATOR_PORT ?? "4810");
const DB_URL = process.env.SUPABASE_DB_URL;

const DEFAULT_SETTINGS: SimSettings = {
  bucketSeconds: 5,
  heartbeatSeconds: 30,
  sendEachPulse: false
};

type LogLine = { at: number; text: string };

type CarbonView = {
  name: string;
  piecesPerPulse: number;
  currentState: string | null;
  currentStateAt: string | null;
  lastSeenAt: string | null;
  lastCounter: number | null;
  lastScrapCounter: number | null;
  sendEachPulse: boolean;
  bucketSeconds: number;
};

type Entry = {
  sim: SimDevice;
  client: MqttClient | null;
  connected: boolean;
  /** What Carbon's retained config says; `overrides` win over it. */
  config: Partial<SimSettings>;
  overrides: Partial<SimSettings>;
  log: LogLine[];
};

const entries = new Map<string, Entry>();
let carbon = new Map<string, CarbonView>();
let dbError: string | null = null;

function addLog(entry: Entry, text: string) {
  entry.log.unshift({ at: Date.now(), text });
  entry.log.length = Math.min(entry.log.length, 50);
}

function describe(message: SimMessage): string {
  switch (message.channel) {
    case "count": {
      const p = message.payload;
      const parts = [`seq ${p.seq}`, `n ${p.n}`];
      if (p.scrap > 0) parts.push(`scrap ${p.scrap}`);
      parts.push(`total ${p.total}`);
      if (!p.tsOk) parts.push("clock not synced");
      return `count · ${parts.join(" · ")}`;
    }
    case "status":
      return `status · total ${message.payload.total} · queue ${message.payload.queue}`;
    case "boot":
      return `boot · ${message.payload.boot}`;
  }
}

function applySettings(entry: Entry) {
  entry.sim.applySettings({ ...entry.config, ...entry.overrides });
}

function getEntry(deviceKey: string): Entry {
  let entry = entries.get(deviceKey);
  if (!entry) {
    entry = {
      sim: new SimDevice(deviceKey, DEFAULT_SETTINGS),
      client: null,
      connected: false,
      config: {},
      overrides: {},
      log: []
    };
    entries.set(deviceKey, entry);
  }
  return entry;
}

function connect(entry: Entry) {
  if (entry.client) return;
  const key = entry.sim.deviceKey;
  const client = mqtt.connect(MQTT_URL, {
    clientId: `pulse-sim-${key}`,
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    clean: true,
    reconnectPeriod: 2000,
    will: { topic: topicFor(key, "online"), payload: "0", qos: 1, retain: true }
  });
  entry.client = client;
  client.on("connect", () => {
    entry.connected = true;
    client.publish(topicFor(key, "online"), "1", { qos: 1, retain: true });
    client.subscribe(topicFor(key, "config"), { qos: 1 });
    addLog(entry, "connected to the broker");
  });
  client.on("close", () => {
    entry.connected = false;
  });
  client.on("error", (error) => addLog(entry, `broker error: ${error.message}`));
  client.on("message", (_topic, raw) => {
    try {
      const config = JSON.parse(raw.toString()) as Partial<SimSettings>;
      entry.config = {
        bucketSeconds: config.bucketSeconds,
        heartbeatSeconds: config.heartbeatSeconds,
        sendEachPulse: config.sendEachPulse ?? false
      };
      applySettings(entry);
      addLog(entry, `config · ${raw.toString()}`);
    } catch {
      addLog(entry, "config · unreadable");
    }
  });
}

/** Drops the connection without a DISCONNECT, so the broker sends the Last Will. */
function disconnectHard(entry: Entry) {
  entry.client?.end(true);
  entry.client = null;
  entry.connected = false;
}

function publish(entry: Entry, messages: SimMessage[]) {
  for (const message of messages) {
    addLog(entry, describe(message));
    entry.client?.publish(
      topicFor(entry.sim.deviceKey, message.channel),
      JSON.stringify(message.payload),
      { qos: 1 }
    );
  }
}

type Body = Record<string, unknown>;

function act(entry: Entry, action: string, body: Body): string | null {
  const sim = entry.sim;
  const now = Date.now();
  const num = (name: string, fallback: number) => {
    const value = Number(body[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  switch (action) {
    case "power-on":
      if (sim.networkUp) connect(entry);
      publish(entry, sim.powerOn(now));
      return null;
    case "unplug":
      sim.unplug();
      disconnectHard(entry);
      addLog(entry, "unplugged");
      return null;
    case "run":
      sim.setRun(now, {
        cycleSeconds: num("cycleSeconds", 5),
        jitterPercent: Math.min(90, Number(body.jitterPercent) || 0)
      });
      addLog(entry, `run · cycle ${sim.run!.cycleSeconds} s`);
      return null;
    case "stop":
      sim.setRun(now, null);
      addLog(entry, "machine stopped");
      return null;
    case "pulse":
      publish(entry, sim.pulse(now, Math.round(num("count", 1))));
      return null;
    case "scrap":
      publish(entry, sim.scrap(now));
      return null;
    case "drop-network":
      sim.dropNetwork();
      disconnectHard(entry);
      addLog(entry, "network down");
      return null;
    case "restore-network":
      if (sim.powered) connect(entry);
      publish(entry, sim.restoreNetwork(now));
      return null;
    case "reboot":
      publish(entry, sim.reboot(now));
      return null;
    case "factory-reset":
      publish(entry, sim.factoryReset(now));
      return null;
    case "drop-next":
      sim.dropNextBucket();
      addLog(entry, "the next bucket will be lost");
      return null;
    case "duplicate":
      publish(entry, sim.duplicateLast());
      return null;
    case "clock":
      sim.setClockSynced(body.synced === true);
      addLog(entry, body.synced === true ? "clock synced" : "clock not synced");
      return null;
    case "settings": {
      entry.overrides = {};
      if (typeof body.sendEachPulse === "boolean") {
        entry.overrides.sendEachPulse = body.sendEachPulse;
      }
      if (Number(body.bucketSeconds) > 0) {
        entry.overrides.bucketSeconds = Number(body.bucketSeconds);
      }
      applySettings(entry);
      return null;
    }
    case "remove":
      sim.unplug();
      disconnectHard(entry);
      entries.delete(sim.deviceKey);
      return null;
    default:
      return `Unknown action ${action}`;
  }
}

function state() {
  const keys = new Set([...carbon.keys(), ...entries.keys()]);
  return {
    broker: MQTT_URL,
    database: DB_URL ? (dbError ?? "connected") : null,
    devices: [...keys].sort().map((key) => {
      const entry = entries.get(key);
      const sim = entry?.sim;
      return {
        deviceKey: key,
        registered: carbon.has(key),
        carbon: carbon.get(key) ?? null,
        device: sim
          ? {
              powered: sim.powered,
              connected: entry!.connected,
              networkUp: sim.networkUp,
              boot: sim.boot,
              seq: sim.seq,
              total: sim.total,
              scrapTotal: sim.scrapTotal,
              queue: sim.queue,
              lost: sim.lost,
              pending: sim.pending,
              tsOk: sim.tsOk,
              run: sim.run,
              settings: sim.settings,
              overrides: entry!.overrides,
              log: entry!.log
            }
          : null
      };
    })
  };
}

async function readBody(request: IncomingMessage): Promise<Body> {
  let text = "";
  for await (const chunk of request) text += chunk;
  if (!text) return {};
  const parsed = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null ? parsed : {};
}

function send(response: ServerResponse, status: number, body: unknown, type = "application/json") {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(type === "application/json" ? JSON.stringify(body) : String(body));
}

const page = readFileSync(new URL("./page.html", import.meta.url), "utf8");

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      return send(response, 200, page, "text/html; charset=utf-8");
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      return send(response, 200, state());
    }
    const match = url.pathname.match(/^\/api\/devices\/([^/]+)\/([a-z-]+)$/);
    if (request.method === "POST" && match) {
      const deviceKey = decodeURIComponent(match[1]!);
      if (!isDeviceKey(deviceKey)) {
        return send(response, 400, { error: "Invalid device key" });
      }
      const error = act(getEntry(deviceKey), match[2]!, await readBody(request));
      return error
        ? send(response, 400, { error })
        : send(response, 200, state());
    }
    send(response, 404, { error: "Not found" });
  } catch (error) {
    send(response, 500, { error: String(error) });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const entry of entries.values()) publish(entry, entry.sim.tick(now));
}, 100);

if (DB_URL) {
  const pool = new pg.Pool({ connectionString: DB_URL, max: 1 });
  const poll = async () => {
    try {
      const { rows } = await pool.query<CarbonView & { deviceKey: string }>(
        `SELECT "deviceKey", name, "piecesPerPulse"::float AS "piecesPerPulse",
                "currentState", "currentStateAt", "lastSeenAt",
                "lastCounter"::float AS "lastCounter",
                "lastScrapCounter"::float AS "lastScrapCounter",
                "sendEachPulse", "bucketSeconds"
           FROM "pulseDevice" WHERE active ORDER BY name`
      );
      carbon = new Map(rows.map(({ deviceKey, ...row }) => [deviceKey, row]));
      dbError = null;
    } catch (error) {
      dbError = String(error);
    }
  };
  void poll();
  setInterval(poll, 2000);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Pulse simulator: http://127.0.0.1:${PORT}  (broker ${MQTT_URL})`);
  if (!MQTT_PASSWORD) {
    console.log("MQTT_PASSWORD / MQTT_GATEWAY_PASSWORD is not set: the broker will refuse the devices.");
  }
});
