# Carbon on Dokploy (bundled Supabase)

Deploy the full Carbon stack — `erp`, `mes`, and a self-hosted **Supabase**
(Postgres, GoTrue, PostgREST, Realtime, Storage, postgres-meta, Kong, Studio,
Edge Functions), plus Redis and Inngest — as a single [Dokploy](https://dokploy.com)
Docker Compose application on your VPS.

This is adapted from [`../simple-docker-caddy`](../simple-docker-caddy), which
does the same thing via Docker Swarm behind a Caddy reverse proxy. This recipe
targets Dokploy instead: plain environment variables (Dokploy's own encrypted
Environment panel) rather than Docker Swarm secrets, and no bundled reverse
proxy — Dokploy's Traefik handles domains and HTTPS.

If you'd rather point Carbon at a Supabase instance you already run somewhere
else, drop the `postgres`/`gotrue`/`postgrest`/`realtime`/`storage`/`meta`/
`studio`/`edge-runtime`/`kong` services from `docker-compose.yml` and set
`SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY`/
`SUPABASE_JWT_SECRET`/`SUPABASE_DB_URL` to point at it instead.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | `erp` + `mes` (built from the repo's root `Dockerfile`), a full self-hosted Supabase, `redis`, and `inngest`. |
| `.env.example` | Template for every environment variable the compose file needs. |
| `bin/run.sh` | Neutral `exec "$@"` entrypoint shim — lets several Supabase images' proven CMD arrays be reused unchanged without Swarm secrets. |
| `postgres/01-roles.sh`, `postgres/02-performance.sh` | Postgres role bootstrap and tuning, run once on first init. |
| `scripts/gen-supabase-keys.sh` | Generates the Supabase JWT key trio (openssl only). |

## 1. Generate secrets

From a machine with this repo checked out (doesn't need to be the VPS):

```bash
openssl rand -hex 24   # POSTGRES_PASSWORD
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # INNGEST_SIGNING_KEY
openssl rand -hex 16   # INNGEST_EVENT_KEY
bash contrib/deploying/dokploy/scripts/gen-supabase-keys.sh   # SUPABASE_JWT_SECRET / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
```

The last command prints a matched trio — use exactly what it prints, don't mix
values from different runs.

## 2. Create the Dokploy application

1. In Dokploy, create a new **Application** of type **Docker Compose**.
2. Point it at this git repository and branch.
3. Set **Compose Path** to `contrib/deploying/dokploy/docker-compose.yml`.

## 3. Configure environment variables

Copy `.env.example` into Dokploy's Environment panel for the application and
fill in every value — the secrets from step 1, plus:

- `DOMAIN`, `ERP_URL`, `MES_URL`, `SUPABASE_URL` — must match the domains you
  set up in step 4.
- GoTrue SMTP settings, if you want invite/magic-link emails to actually send.
- Postgres tuning (`PG_*`) — defaults suit a ~4 GB VPS; adjust for yours.

## 4. Configure domains

In Dokploy's **Domains** tab for this application, add a domain for each of:

- `erp` (internal port `3000`)
- `mes` (internal port `3000`)
- `kong` (internal port `8000`) — this is the Supabase API gateway; its
  domain must match `SUPABASE_URL` from step 3.

Enable HTTPS on all three — Dokploy provisions Let's Encrypt certificates via
its own Traefik instance automatically.

`studio` (the DB admin UI) is intentionally **not** domain-mapped by default —
it has no auth of its own. Reach it via an SSH tunnel to the VPS
(`ssh -L 3000:localhost:<studio-container-port> ...`) or, if you must expose
it, add a domain in Dokploy and put it behind Dokploy's own basic-auth /
access-control feature first.

## 5. Deploy

Trigger a deploy in Dokploy. It builds the `erp` and `mes` images from the
repo's root `Dockerfile` and pulls the pinned Supabase/Redis/Inngest images.

## 6. Apply database migrations (once, after first deploy)

```bash
pnpm exec supabase migration up --include-all \
  --db-url "postgresql://supabase_admin:<POSTGRES_PASSWORD>@<kong-or-postgres-host>:5432/postgres"
```

Run this from a machine with this repo checked out and `pnpm install` already
done, or from a shell opened into the running `erp` container via Dokploy's
terminal/exec feature (where the `postgres` hostname resolves on the compose
network). Substitute the `POSTGRES_PASSWORD` you generated in step 1.

## 7. Verify

```bash
curl -f https://erp.example.com/health
curl -f https://mes.example.com/health
curl -f https://supabase.example.com/auth/v1/health
```
