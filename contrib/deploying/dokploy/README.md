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

The `postgres` service isn't published outside the Docker network, and Kong
only proxies HTTP (auth/rest/storage/realtime) — it can't carry a raw Postgres
connection. Run the migration from *inside* the compose network instead:

1. Open a terminal into the running `erp` container via Dokploy's
   terminal/exec feature (the image ships the full repo checkout at `/repo`,
   including `pnpm`).
2. `cd /repo/packages/database`
3. Run, substituting the `POSTGRES_PASSWORD` you generated in step 1 (the
   hostname stays exactly `postgres` — that's the compose service name,
   resolvable because this shell is on the same network). The bundled
   Postgres doesn't have TLS configured, so the connection must explicitly
   disable it — otherwise the CLI fails with `tls error (server refused TLS
   connection)`:

   ```bash
   PGSSLMODE=disable pnpm exec supabase migration up --include-all \
     --db-url "postgresql://supabase_admin:<POSTGRES_PASSWORD>@postgres:5432/postgres?sslmode=disable"
   ```

## 7. Verify

```bash
curl -f https://erp.example.com/health
curl -f https://mes.example.com/health
curl -f https://supabase.example.com/auth/v1/health
```

Then log in at `https://erp.example.com/login` with the email you want as the
first admin — there's no separate account-bootstrap script. An unknown email
gets a 6-digit verification code (sent via `RESEND_API_KEY`, so that must be
set) and is walked into the onboarding wizard, which creates the first
company and makes that user its owner. `GOTRUE_DISABLE_SIGNUP=true` does not
block this — Carbon's signup goes through the Supabase admin API
(service-role key), a separate path from GoTrue's public self-service signup.

## Troubleshooting

**"Failed to send verification code" on first login** — `RESEND_API_KEY` is
missing/invalid, or `RESEND_DOMAIN` isn't a verified sending domain in your
Resend account. Check the `erp` container logs right after a login attempt
for the underlying Resend error. To unblock testing without email delivery,
set `DISABLE_RESEND=1` on `erp` and redeploy — the verification code gets
printed to the `erp` logs instead of emailed (not for production use, since
other features like user invites also go through Resend).

**An edge function fails with `worker boot error: ... could not find an
appropriate entrypoint`** (e.g. onboarding's "Fatal: failed to seed company")
— `edge-runtime` bind-mounts `packages/database/supabase/functions` and
`packages/dev/docker/edge-main` from the repo checkout. Docker only
evaluates a bind mount when a container is *created*, not on every start —
if `edge-runtime` was created before a `git pull` populated those
directories (e.g. it wasn't recreated on some earlier deploy while other
services were), it keeps serving an empty, stale view of them indefinitely.
Fix: force it to recreate —

```bash
cd <dokploy-compose-checkout>/contrib/deploying/dokploy
docker compose up -d --force-recreate edge-runtime
```

or trigger a full **Redeploy** from the Dokploy UI, which recreates every
service. Confirm with `docker exec <edge-runtime-container> ls -la
/home/deno/functions/<function-name>/` — it should show `index.ts`, not an
empty directory.
