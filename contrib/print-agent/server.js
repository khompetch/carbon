// Carbon print agent — a minimal ProxyBox-compatible print server.
//
// Carbon's print-job delivery (packages/printing/src/delivery/proxybox.ts)
// POSTs the rendered label (raw ZPL text or PDF bytes) as
// application/octet-stream with an X-API-Key header and expects a 2xx within
// 30 seconds. This agent implements that contract and forwards the bytes to a
// printer over raw TCP (port 9100 — the standard "raw" port Zebra and most
// network laser printers listen on).
//
// Configuration is env-driven, one variable per printer:
//   PRINTER_<NAME>=tcp://<host>[:port]     (port defaults to 9100)
// Each printer is served at POST /print/<name> (name lowercased).
//
//   API_KEY=...      required — requests must carry X-API-Key: <API_KEY>
//   PORT=8631        listen port (default 8631)
//
// Plain Node (>=18), no dependencies. See README.md for setup.

const http = require("node:http");
const net = require("node:net");
const { timingSafeEqual } = require("node:crypto");

const PORT = Number(process.env.PORT ?? 8631);
const API_KEY = process.env.API_KEY;
const MAX_BYTES = 10 * 1024 * 1024; // labels are tiny; 10 MB is generous
const PRINTER_TIMEOUT_MS = 15_000; // well under Carbon's 30 s delivery timeout

if (!API_KEY) {
  console.error(
    "API_KEY is not set. Refusing to start — this agent is designed to be " +
      "reachable from the internet (via a tunnel), so authentication is mandatory."
  );
  process.exit(1);
}

const printers = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("PRINTER_")) continue;
  const name = key.slice("PRINTER_".length).toLowerCase();
  let url;
  try {
    url = new URL(value);
  } catch {
    console.error(`${key}: "${value}" is not a valid URL`);
    process.exit(1);
  }
  if (url.protocol !== "tcp:") {
    console.error(`${key}: unsupported protocol "${url.protocol}" — use tcp://host[:port]`);
    process.exit(1);
  }
  printers[name] = { host: url.hostname, port: Number(url.port || 9100) };
}

if (Object.keys(printers).length === 0) {
  console.error(
    "No printers configured. Set at least one PRINTER_<NAME>=tcp://host[:port]."
  );
  process.exit(1);
}

function isAuthorized(req) {
  const provided = req.headers["x-api-key"];
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

function forwardToPrinter({ host, port }, body) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(PRINTER_TIMEOUT_MS);
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error(`connection to ${host}:${port} timed out`));
    });
    socket.on("connect", () => {
      // end(body) writes everything then half-closes; 'close' fires once the
      // printer side closes too, at which point the bytes are flushed.
      socket.end(body);
    });
    socket.on("close", (hadError) => {
      if (!hadError) resolve();
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, printers: Object.keys(printers) }));
    return;
  }

  const match = req.method === "POST" && req.url?.match(/^\/print\/([a-z0-9_-]+)$/);
  if (!match) {
    res.writeHead(404).end("Not found");
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401).end("Invalid or missing X-API-Key");
    return;
  }

  const printer = printers[match[1]];
  if (!printer) {
    res.writeHead(404).end(`Unknown printer "${match[1]}"`);
    return;
  }

  const chunks = [];
  let received = 0;
  let aborted = false;
  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_BYTES) {
      aborted = true;
      res.writeHead(413).end("Payload too large");
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", async () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);
    if (body.length === 0) {
      res.writeHead(400).end("Empty body");
      return;
    }
    try {
      await forwardToPrinter(printer, body);
      console.log(
        `[${new Date().toISOString()}] printed ${body.length} bytes on "${match[1]}" (${printer.host}:${printer.port})`
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, bytes: body.length }));
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] FAILED printing on "${match[1]}": ${err.message}`
      );
      res.writeHead(502).end(`Printer delivery failed: ${err.message}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(
    `carbon print agent listening on :${PORT} — printers: ${Object.keys(printers).join(", ")}`
  );
});
