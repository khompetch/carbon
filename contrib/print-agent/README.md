# Carbon print agent (ProxyBox-compatible)

A tiny, dependency-free print server that lets Carbon's auto-print system
reach physical label printers on your factory network. It implements the same
HTTP contract Carbon's delivery task speaks
(`packages/printing/src/delivery/proxybox.ts`): a `POST` of raw label bytes
(ZPL text or PDF) with an `X-API-Key` header, answered with a 2xx once the
bytes have been handed to the printer.

Run it on any always-on machine on the same LAN as the printers — a Raspberry
Pi is plenty. The agent forwards jobs to printers over raw TCP port 9100,
which Zebra thermal printers and most network laser printers accept natively.

```
Carbon (VPS) ──HTTPS──▶ Cloudflare Tunnel ──▶ print-agent ──TCP 9100──▶ Zebra
        trigger("print-job")                   (factory LAN)
```

## Files

| File | Purpose |
|---|---|
| `server.js` | The agent — plain Node (>= 18), no dependencies. |
| `Dockerfile` / `docker-compose.yml` | Containerized deployment, with an optional Cloudflare Tunnel sidecar. |
| `.env.example` | Configuration template. |

## 1. Configure

```bash
cp .env.example .env
openssl rand -hex 24     # → API_KEY
```

Edit `.env`:

- `API_KEY` — required; Carbon sends it as `X-API-Key`.
- `PRINTER_<NAME>=tcp://<host>[:port]` — one per printer. `<NAME>`
  (lowercased) becomes the endpoint path, e.g. `PRINTER_ZEBRA1=tcp://192.168.1.50`
  is served at `POST /print/zebra1`. Port defaults to `9100`.

## 2. Run

```bash
docker compose up -d --build
```

Sanity-check from another machine on the LAN:

```bash
curl -s http://<agent-ip>:8631/health
# {"ok":true,"printers":["zebra1"]}

printf '^XA^FO50,50^A0N,40,40^FDHello^FS^XZ' | \
  curl -s -X POST http://<agent-ip>:8631/print/zebra1 \
    -H "X-API-Key: <API_KEY>" -H "Content-Type: application/octet-stream" \
    --data-binary @-
# the Zebra should print a small "Hello" label
```

(Without Docker: `API_KEY=... PRINTER_ZEBRA1=tcp://... node server.js`.)

## 3. Expose it to your Carbon server

Carbon's print jobs run on your Carbon host (e.g. a cloud VPS), so it must be
able to reach the agent. Pick one:

**Cloudflare Tunnel (recommended — no inbound port on the factory router):**

1. In [Cloudflare Zero Trust](https://one.dash.cloudflare.com) →
   Networks → Tunnels → **Create a tunnel** (Cloudflared connector) and copy
   the token into `TUNNEL_TOKEN` in `.env`.
2. In the tunnel's **Public Hostname** tab, map a hostname (e.g.
   `printers.example.com`) to service `http://print-agent:8631`.
3. Start with the tunnel profile:

   ```bash
   docker compose --profile tunnel up -d
   ```

Your printer URL is then `https://printers.example.com/print/zebra1`.

**Alternatives:** a WireGuard/Tailscale VPN between the VPS and the factory
(use the agent's VPN IP), or a router port-forward (only with HTTPS in front
and a strong `API_KEY` — the agent itself speaks plain HTTP).

## 4. Register in Carbon

In the ERP: **Settings → Printing → Printers → New**:

- **Format**: `ZPL (Thermal Label)` for Zebra, `PDF (Document)` for document
  printers (the target printer must support direct PDF printing on port 9100).
- **Printer URL**: `https://printers.example.com/print/zebra1`
- **API Key**: the `API_KEY` from step 1.

Use **Test Print** to verify, then in the **Assignments** card map the printer
to each location/context (receiving, shipping, inventory, work centers) and
switch **Auto-Print** on where you want labels printed automatically — e.g.
the work-center context prints a tracking label when an MES operator completes
the first operation of a serialized/batch-tracked part.

## Endpoint reference

| Endpoint | Description |
|---|---|
| `GET /health` | `{ok: true, printers: [...]}` — no auth, for monitoring. |
| `POST /print/<name>` | Body = raw ZPL/PDF bytes. Requires `X-API-Key`. `200` on success, `401` bad key, `404` unknown printer, `413` > 10 MB, `502` printer unreachable. |

## Troubleshooting

- **Test Print fails in Carbon but curl from the LAN works** — the Carbon
  host can't reach the agent URL; check the tunnel/VPN, and that the URL in
  the printer settings includes the `/print/<name>` path.
- **`502 Printer delivery failed`** — the agent couldn't open TCP to the
  printer: verify the printer IP in `.env`, that it's powered on, and that
  port 9100 ("raw" printing) is enabled on the printer.
- **Prints garbage on a laser printer** — the printer route in Carbon is set
  to ZPL but the device isn't a ZPL printer; switch the format to PDF (and
  make sure the printer supports direct PDF, or put CUPS in front).
