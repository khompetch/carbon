# contrib

Community-contributed, optional extras for Carbon — deployment recipes, examples,
and tooling that live alongside the codebase but aren't part of the core apps.

These are reference setups: read them, copy them, adapt them to your environment.
They are not load-bearing for development (`crbn up`) or the managed cloud build.

## Deployment

| Recipe | What it does |
|---|---|
| [`deploying/simple-docker-caddy`](deploying/simple-docker-caddy) | Self-host the full stack (ERP + MES + Supabase + Redis + Inngest) on a **single Linux VPS** with a single-node **Docker Swarm** and an auto-HTTPS **Caddy** reverse proxy. Swarm secrets, host hardening, backups included. |
| [`deploying/dokploy`](deploying/dokploy) | Self-host the full stack (ERP + MES + Supabase + Redis + Inngest) as a single **Dokploy** Docker Compose application — the same idea as `simple-docker-caddy` but for Dokploy's own Traefik/env-var model instead of Docker Swarm + Caddy. |

## Factory tools

| Recipe | What it does |
|---|---|
| [`print-agent`](print-agent) | A tiny ProxyBox-compatible **print server** for the factory network — receives Carbon's auto-print jobs over HTTPS (optional Cloudflare Tunnel sidecar) and forwards the raw ZPL/PDF to label printers on TCP 9100. |
