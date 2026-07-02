# Carbon on Dokploy (existing Supabase)

Deploy Carbon's `erp` and `mes` apps as a [Dokploy](https://dokploy.com) Docker
Compose application on a VPS where **Supabase is already running** (e.g. via a
Dokploy Supabase template) — without standing up a second Postgres/GoTrue/Kong
stack.

If you don't already have Supabase running and want Carbon to manage the
whole stack itself (Postgres, GoTrue, Kong, Redis, Inngest) on a single VPS,
use [`../simple-docker-caddy`](../simple-docker-caddy) instead — that recipe
is self-contained but isn't designed to point at an external Supabase.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | `erp` + `mes` (built from the repo's root `Dockerfile`), plus `redis` and a self-hosted `inngest` — no bundled Supabase or reverse proxy. |
| `.env.example` | Template for every environment variable the compose file needs. |

## 1. Get your existing Supabase's connection details

From the Supabase deployment already running in Dokploy, collect:

- **`SUPABASE_URL`** — the public URL/domain routed to its API gateway (Kong or
  equivalent).
- **`SUPABASE_ANON_KEY`** and **`SUPABASE_SERVICE_ROLE_KEY`** — the anon/
  service-role JWTs it was deployed with.
- **`SUPABASE_JWT_SECRET`** — the JWT secret its GoTrue/PostgREST use (the two
  keys above must be signed with this same secret).
- **`SUPABASE_DB_URL`** — a direct Postgres connection string, e.g.
  `postgresql://postgres:<password>@<host>:5432/postgres`.

These normally live in the environment variables of whatever compose stack
Dokploy used to deploy Supabase — check that application's Environment panel
in Dokploy, or the compose file it was created from.

## 2. Create the Dokploy application

1. In Dokploy, create a new **Application** of type **Docker Compose**.
2. Point it at this git repository and branch.
3. Set **Compose Path** to `contrib/deploying/dokploy/docker-compose.yml`.

## 3. Configure environment variables

Copy `.env.example` into Dokploy's Environment panel for the application and
fill in every value:

- The five `SUPABASE_*` values from step 1.
- `SESSION_SECRET` — generate with `openssl rand -hex 32`.
- `INNGEST_SIGNING_KEY` / `INNGEST_EVENT_KEY` — only needed if you keep the
  bundled `inngest` service; generate with `openssl rand -hex 32` / `openssl
  rand -hex 16`, or use an Inngest Cloud account instead.
- `DOMAIN`, `ERP_URL`, `MES_URL` — must match the domains you set up in step 4.
- `REDIS_URL` — defaults to the bundled `redis` service; point it at an
  existing Redis instead (and delete the `redis` service from the compose
  file) if Dokploy already runs one you'd rather reuse.

## 4. Configure domains

In Dokploy's **Domains** tab for this application, add a domain for the `erp`
service (internal port `3000`) and a separate one for `mes` (internal port
`3000`), with HTTPS enabled. Dokploy provisions Let's Encrypt certificates via
its own Traefik instance automatically — no reverse proxy config needed in
this recipe.

## 5. Deploy

Trigger a deploy in Dokploy. It builds the `erp` and `mes` images from the
repo's root `Dockerfile` (`--build-arg APP=erp` / `APP=mes`) per the `build:`
blocks in `docker-compose.yml`.

## 6. Apply database migrations (once, against the existing Supabase DB)

This touches your production database directly, so run it yourself rather
than through Dokploy's automated deploy:

```bash
pnpm exec supabase migration up --include-all --db-url "<SUPABASE_DB_URL>"
```

Run this from a machine with this repo checked out and `pnpm install` already
done (your own workstation, or a shell opened into the running `erp`
container via Dokploy's terminal/exec feature).

## 7. Verify

Both apps expose a health endpoint — confirm each responds after deploy:

```bash
curl -f https://erp.example.com/health
curl -f https://mes.example.com/health
```
