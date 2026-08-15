---
description: Self-hosted single-VPS deployment — plain Docker Compose stack under contrib/deploying/dokploy, managed by Dokploy. Plain env vars instead of Swarm secrets, Dokploy's Traefik instead of a bundled proxy, and a gated one-shot migration job.
paths:
  - "contrib/deploying/dokploy/**"
---

# Self-host: single-VPS Dokploy + Compose (`contrib/deploying/dokploy`)

Self-host the whole stack (ERP + MES + full Supabase data plane + Redis +
Inngest) on **one Linux VPS** as a single **plain Docker Compose v2** project
that [Dokploy](https://dokploy.com) deploys from git. Sibling of
[contrib-deploying-swarm.md](contrib-deploying-swarm.md), which does the same
thing via Docker Swarm + Caddy — read that one too, its `paths:` is
`contrib/deploying/**` so it auto-loads here anyway. Both build from the same
root `Dockerfile` (`--build-arg APP=erp|mes`).

Two deliberate differences from the Swarm recipe:
- **Plain environment variables** (Dokploy's encrypted Environment panel writes
  them to `.env` beside the compose file) instead of Docker Swarm secrets. There
  is therefore **no `__SECRET__` placeholder substitution** — `bin/run.sh` is a
  bare `exec "$@"`.
- **No bundled reverse proxy.** Dokploy's own Traefik terminates TLS and maps
  domains; there is no Caddy service and nothing publishes ports.

## Files (all under `contrib/deploying/dokploy/`)
- `docker-compose.yml` — 14 services: `migrate`, `erp`, `mes`, `redis`,
  `inngest`, `postgres`, `gotrue`, `postgrest`, `realtime`, `storage`, `meta`,
  `studio`, `edge-runtime`, `kong`. Unlike the Swarm file this IS
  `docker compose up`-able: it uses `build:`, `depends_on`, `restart:`, a
  top-level `x-erp-build` anchor, and no `deploy:`/`secrets:` blocks.
- `edge-runtime.Dockerfile` — bakes `packages/database/supabase/functions`,
  `packages/database/src`, and `packages/dev/docker/edge-main` INTO the image.
  Build context is the repo root. No `run.sh` shim (the root `.dockerignore`
  excludes `contrib/` from the build context; a Dockerfile sets ENTRYPOINT
  directly).
- `bin/run.sh` — neutral `exec "$@"` ENTRYPOINT shim. Pins the same entrypoint
  position the Swarm recipe uses so the proven CMD arrays copy over verbatim.
  It substitutes nothing.
- `postgres/01-roles.sh` — Supabase role passwords from `POSTGRES_PASSWORD`.
- `postgres/02-performance.sh` — first-init tuning via `ALTER SYSTEM` from
  `CARBON_PG_*`.
- `scripts/gen-supabase-keys.sh` — Supabase JWT trio, `openssl` only.
- `scripts/backup.sh` — `pg_dump` + storage volume tarball.
- `.env.example` — EVERY variable, secrets included (unlike the Swarm recipe,
  where `.env` is non-secret config only).

## The migration gate — the defining feature

`migrate` is a **one-shot job**, Compose's equivalent of the Swarm
`--mode replicated-job` in `deploy.sh cmd_migrate`:

```
postgres + storage healthy → migrate runs to completion → erp + mes start
```

- `image: ${CARBON_IMAGE_ERP:-carbon-erp:local}` + `build: *erp-build` — the
  SAME image `erp` runs, so schema and code cannot come from different
  revisions. It carries `build:` as well as `image:` so a `docker compose pull`
  can't go hunting for a local-only tag on a registry.
- `restart: "no"` (quoted — bare `no` is YAML false). A finished job must stay
  finished; `unless-stopped` would loop it forever. `Exited (0)` is the healthy
  steady state and Dokploy's UI shows it greyed/red — that is not a failure.
- `depends_on: postgres + storage: condition: service_healthy`. Storage is
  gated because storage-api runs its OWN migrations on the `storage` schema at
  boot; the Swarm recipe waits for it too (`wait_healthy storage 180`, which
  calls `error()` → `exit 1`, so it is a hard gate there as well). Compose has
  no timeout knob for `service_healthy`, so a storage that never goes healthy
  HANGS the deploy rather than failing it.
- `erp`/`mes` carry `depends_on: migrate: condition:
  service_completed_successfully`, so a failed migration aborts the deploy
  instead of leaving apps on a stale schema.
- Command: `pnpm exec supabase migration up --include-all --db-url
  "postgresql://supabase_admin:$$POSTGRES_PASSWORD@postgres:5432/postgres?sslmode=disable"`.
  `$$` survives compose interpolation as a literal `$` so **sh** expands the
  password inside the container, keeping it out of argv. `supabase_admin` (not
  `postgres`) because the migrations create Supabase-owned schemas/extensions.
  `--include-all` or the CLI silently skips any migration whose timestamp
  predates the newest applied one.

**The gate only binds containers Compose actually RECREATES.** Observed in
production: a deploy where only `mes`'s `depends_on` changed left the running
`mes` container untouched (`depends_on` is orchestration metadata, not container
config), so it ran straight through the migration while a freshly-recreated
`erp` started 307 ms after `migrate` exited. In practice new migrations also
change the image (they are in the build context via `COPY packages ./packages`),
so both apps get recreated — but this is exactly why migrations must be written
**expand-then-contract**. Force one service onto the current definition with
`docker compose up -d --force-recreate <svc>`.

Normal `migrate` log output is three parts: ~6 `WARN: environment variable is
unset: SUPABASE_AUTH_EXTERNAL_*` (the CLI parsing `config.toml`'s `env(...)`
OAuth blocks — irrelevant to `migration up`), the real result
(`Local database is up to date.` / applied list), and a posthog TLS warning
(CLI telemetry, fires after the work, does not affect the exit code).

## Key facts / gotchas

- **Every `.sh` here must stay mode `100755` in git.** `bin/run.sh` is the
  `entrypoint:` for SIX services (`postgres`, `gotrue`, `realtime`, `storage`,
  `meta`, `studio`) via `./bin/run.sh:/carbon/bin/run.sh:ro`. Committed at
  `100644` — trivially done from a `core.fileMode=false` Windows checkout — every
  one of them dies with `exec: "/carbon/bin/run.sh": permission denied` while
  `erp`/`mes`/`inngest` start fine. Fix in git (`git update-index --chmod=+x`),
  never with `chmod` on the server; the next clone undoes that.
- **`postgrest` does NOT use the shim** (image is FROM scratch, no shell). It
  reads plain env vars here — there is no `@file` secret indirection, since
  there are no Swarm secrets.
- **postgres does NOT override `shared_preload_libraries`** — the image default
  already preloads `pg_net`, `pg_cron`, `pgsodium`, `supabase_vault`, …;
  overriding it drops `pg_net` and breaks the webhooks migration's
  `CREATE EXTENSION pg_net`.
- **`postgres/01-roles.sh` runs ONLY on first init of an empty `pgdata` volume**
  (`/docker-entrypoint-initdb.d`). A volume created before it landed keeps the
  image's default passwords, and everything fails with `password authentication
  failed for user "supabase_admin"`. Confirm with
  `docker compose logs postgres | grep zz-carbon-01-roles`.
- **Postgres has no TLS** → every DSN carries `?sslmode=disable`, and `migrate`
  also sets `PGSSLMODE=disable`. Without both the CLI fails with
  `tls error (server refused TLS connection)`.
- **Edge functions are BAKED, not bind-mounted** (`edge-runtime.Dockerfile`).
  Docker only evaluates a bind mount when a container is *created*, so an
  `edge-runtime` created while the Dokploy checkout was still syncing served an
  empty functions dir forever (`worker boot error: … could not find an
  appropriate entrypoint`, surfacing as onboarding's "Fatal: failed to seed
  company"). A Redeploy now ships function changes atomically with the image.
- **`kong` still bind-mounts** `../../../packages/dev/docker/kong.yml`, so the
  repo checkout must exist on the host. It is the only Supabase service needing
  a domain (map it to `SUPABASE_URL`).
- **Healthchecks use `127.0.0.1`, never `localhost`**; `studio` additionally
  needs `HOSTNAME=0.0.0.0` (Next.js standalone binds `$HOSTNAME`, which Docker
  sets to the container id) plus a healthcheck override with a `start_period`.
- **Domains**: `erp` (3000), `mes` (3000), `kong` (8000) get Dokploy domains.
  `studio` is deliberately unmapped — it has no auth of its own.
- **Build OOM on small VPSes**: `COMPOSE_PARALLEL_LIMIT=1` in `.env` plus the
  `NODE_OPTIONS: --max-old-space-size=4096` build arg in `x-erp-build`. Symptom
  is a hang around `rendering chunks`.
- **`CARBON_IMAGE_ERP`** tags the erp image; `erp` and `migrate` must resolve to
  the same value. Override it to run two Carbon stacks on one host or to pull a
  prebuilt registry image.
- **Volumes**: `pgdata`, `storage`, `redis-data`, `inngest-data`. A backup is
  the PAIRED `db.sql.gz` + `storage.tar.gz` (`STORAGE_BACKEND: file` puts
  uploads on the volume, metadata in Postgres) — restore both or neither.
- **First admin**: no bootstrap script. Logging in at `/login` with an unknown
  email sends a 6-digit code (needs a working `RESEND_API_KEY`; `DISABLE_RESEND=1`
  prints it to the `erp` log instead) and walks into the onboarding wizard, which
  creates the first company and its owner. `GOTRUE_DISABLE_SIGNUP=true` does not
  block this — Carbon signs up through the Supabase admin API.

## Verify after editing

```bash
cd contrib/deploying/dokploy
docker compose config --quiet          # must parse
docker compose config | grep '\${'     # must be empty — no unresolved vars
```

`docker compose config` re-escapes a literal `$` as `$$` on output, so seeing
`$$POSTGRES_PASSWORD` in `migrate`'s command is correct, not a double-escape.
Also confirm `migrate` and `erp` print the same `image:` value.
