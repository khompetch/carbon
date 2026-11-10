# Carbon on Dokploy (bundled Supabase)

Deploy the full Carbon stack — `erp`, `mes`, and a self-hosted **Supabase**
(Postgres 17, GoTrue, PostgREST, Realtime, Storage + imgproxy, Supavisor, an
Envoy API gateway, Edge Functions, and an optional Studio), plus Redis and
Inngest — as a single [Dokploy](https://dokploy.com) Docker Compose
application on your VPS.

This is adapted from [`../simple-docker-caddy`](../simple-docker-caddy), which
does the same thing via Docker Swarm behind a Caddy reverse proxy. This recipe
targets Dokploy instead: plain environment variables (Dokploy's own encrypted
Environment panel) rather than Docker Swarm secrets, and no bundled reverse
proxy — Dokploy's Traefik handles domains and HTTPS.

**Upgrading an existing deployment?** Read [Upgrading](#upgrading) first. The
move to Postgres 17 and the Envoy gateway needs manual steps; a plain Redeploy
stops at `pg-version-check`.

If you'd rather point Carbon at a Supabase instance you already run somewhere
else, drop the `pg-version-check`/`postgres`/`supavisor`/`gotrue`/`postgrest`/
`realtime`/`storage`/`imgproxy`/`meta`/`studio`/`edge-runtime`/`gateway`
services from `docker-compose.yml` and set `SUPABASE_URL`/`SUPABASE_ANON_KEY`/
`SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_JWT_SECRET`/`SUPABASE_DB_URL`/
`SUPABASE_DB_POOLER_URL` to point at it instead.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | `erp` + `mes` (built from the repo's root `Dockerfile`), a one-shot `migrate` job that gates them (built from the same Dockerfile's `bootstrap` stage), a full self-hosted Supabase, `redis`, and `inngest`. |
| `edge-runtime.Dockerfile` | Bakes the edge functions into the `edge-runtime` image (bind mounts proved fragile — see Troubleshooting). |
| `envoy/` | The API gateway's config (from BYOC, the same files as `../simple-docker-caddy/envoy`). |
| `supavisor/pooler.exs` | Seeds Supavisor's tenant on boot (from BYOC). |
| `.env.example` | Template for every environment variable the compose file needs. |
| `bin/run.sh` | Neutral `exec "$@"` entrypoint shim — lets several Supabase images' proven CMD arrays be reused unchanged without Swarm secrets. |
| `postgres/01-roles.sh`, `02-performance.sh`, `03-pooler.sh` | Role passwords, tuning, and what Supavisor needs (`_supabase` database, `pgbouncer` role). Run once, on first init of an empty `pgdata` volume. |
| `scripts/gen-supabase-keys.sh` | Generates the Supabase JWT key trio (openssl only). |
| `scripts/backup.sh` | Nightly-able backup: Postgres dump + storage volume archive. |

## 1. Generate secrets

From a machine with this repo checked out (doesn't need to be the VPS):

```bash
openssl rand -hex 24   # POSTGRES_PASSWORD
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # INNGEST_SIGNING_KEY
openssl rand -hex 16   # INNGEST_EVENT_KEY
openssl rand -hex 32   # SUPAVISOR_SECRET_KEY_BASE
openssl rand -hex 16   # SUPAVISOR_VAULT_ENC_KEY
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
- SMTP (`GOTRUE_SMTP_*` and `SMTP_FROM`). GoTrue (magic links, invites) and the
  apps both send through this one account. Without it, no email is sent.
- `ADMIN_EMAIL` — the first admin account (see step 7).
- Postgres tuning (`PG_*`) — defaults suit a ~4 GB VPS; adjust for yours.

## 4. Configure domains

In Dokploy's **Domains** tab for this application, add a domain for each of:

- `erp` (internal port `3000`)
- `mes` (internal port `3000`)
- `gateway` (internal port `8000`) — this is the Supabase API gateway; its
  domain must match `SUPABASE_URL` from step 3.

Enable HTTPS on all three — Dokploy provisions Let's Encrypt certificates via
its own Traefik instance automatically.

Never map a domain to `imgproxy`, `supavisor`, `meta` or `studio`. imgproxy reads
the storage volume with no RLS, and meta runs SQL as `supabase_admin` with no
auth.

### Supabase Studio

Studio and postgres-meta are **off by default**. To run them, add
`COMPOSE_PROFILES=studio` to the environment and redeploy. Then reach Studio
through an SSH tunnel to the container's IP:

```bash
# on the VPS
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <project>-studio-1
# from your machine
ssh -L 3000:<studio-ip>:3000 <vps>   # then open http://localhost:3000
```

Remove the profile again when you are done.

## 5. Deploy

Trigger a deploy in Dokploy. It builds the `erp` and `mes` images from the
repo's root `Dockerfile`, builds the small `bootstrap` image that the `migrate`
job runs (it installs only `@carbon/database`), bakes the `edge-runtime` image,
and pulls the pinned Supabase/Redis/Inngest images.

The start order is:

```
pg-version-check → postgres → supavisor, gotrue, postgrest, storage, gateway …
postgres + storage healthy → migrate (migrations, then seed) → erp + mes
```

## 6. Database migrations (automatic)

**You don't run these by hand.** The compose file has a one-shot `migrate`
service that runs on every deploy, and `erp`/`mes` gate on it via
`depends_on: condition: service_completed_successfully`. It does two things:

1. `supabase migration up --include-all` — applies pending migrations.
2. `pnpm db:seed` (`packages/database/src/seed.ts`) — idempotent, safe on
   every deploy. It writes:
   - the `config` row (`apiUrl` + `anonKey`). Database triggers use it to call
     back into the API. Because the job sets it to the internal gateway URL,
     Postgres never goes out through Traefik.
   - the `inngest_event_url` Vault secret. Without it, Postgres never delivers
     its events (event queue, notifications) to Inngest.
   - the `ADMIN_EMAIL` account, when that is set.

   The seed is retried up to 10 times, because GoTrue and PostgREST can still
   be booting when the migrations finish.

That ordering is the point: app code never boots against a schema that hasn't
caught up to it, and a failed migration aborts the deploy loudly instead of
leaving the apps serving against a stale schema. It mirrors what
[`../simple-docker-caddy`](../simple-docker-caddy) does with a Swarm
`--mode replicated-job` (`deploy.sh` → `cmd_migrate`).

The job runs the root `Dockerfile`'s `bootstrap` stage, built from the same
revision as `erp`, so the schema and the code that assumes it can never come
from different revisions. It is a separate image from the one `erp` serves
because the served `runner` stage deliberately strips the supabase CLI (along
with esbuild, tar and npm) to keep build-tool CVEs out of the image that faces
the internet; `bootstrap` is the un-hardened stage kept for exactly these
short-lived jobs. `migrate` exits with code 0 and stays exited. Dokploy shows
it greyed out; that is not a failure.

**The first deploy is the slow one** — there are ~1000 migrations to apply and
it takes several minutes. Watch the `migrate` service's logs in Dokploy. If
your deploy times out before it finishes, apply them once manually (below),
then redeploy — subsequent runs only have to apply what's new.

### Running migrations by hand

Still useful for bootstrapping a slow first run, or for debugging. `postgres`
isn't published outside the Docker network and the gateway only proxies HTTP —
it can't carry a raw Postgres connection — so this has to run from *inside*
the compose network:

SSH to the VPS, go to the directory Dokploy checked the compose file out into
(`/etc/dokploy/compose/<app-name>/code/contrib/deploying/dokploy` — it holds
the generated `.env` too), and re-run the one-shot job:

```bash
docker compose -p <project> run --rm migrate
```

`-p <project>` matters: without it Compose derives the project name from the
directory and you get a **second, empty stack** — new volumes, no data. Read
the right value off a running container
(`docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' <container>`).

That runs the migrations and the seed in a fresh container on the stack's own
network with the same env the deploy uses — no password to paste — and is safe
to repeat.

To drive the CLI yourself, run it in the **bootstrap** image (the `migrate`
service), not `erp` — the served app image strips the Supabase CLI:

```bash
docker compose -p <project> run --rm --entrypoint sh migrate -c '
  PGSSLMODE=disable pnpm exec supabase migration up --include-all \
    --db-url "postgresql://supabase_admin:$POSTGRES_PASSWORD@postgres:5432/postgres?sslmode=disable"
'
```

Dokploy's terminal/exec feature only attaches to a *running* container and
`migrate` is exited by design, so these have to come from an SSH session.

Four things that are easy to get wrong:

- **`supabase_admin`, not `postgres`** — the migrations create Supabase-owned
  schemas and extensions.
- **The host is literally `postgres`** — the compose service name, resolvable
  because this shell is on the same network.
- **Both `PGSSLMODE=disable` and `?sslmode=disable`** — the bundled Postgres has
  no TLS configured, so without them the CLI fails with `tls error (server
  refused TLS connection)`.
- **`--include-all`** — without it the CLI silently skips every migration whose
  timestamp predates the newest one already applied.

### Before a deploy that carries migrations

There are no down migrations; the only way back is a restore. Run
`./scripts/backup.sh` (step 9) *before* deploying schema changes, not just
nightly. Write migrations expand-then-contract — add the new column, ship code
that writes both, backfill, and only drop the old one in a later deploy — so
the old containers keep working during the window where both are alive.

## 7. First admin

`GOTRUE_DISABLE_SIGNUP=true` keeps the public signup closed, so somebody has to
exist first. Two ways:

- **`ADMIN_EMAIL`** (recommended): set it and redeploy. The `migrate` job
  creates that account and makes it the instance admin. Log in at
  `https://erp.example.com/login` with a magic link, and the onboarding wizard
  creates the first company.
- **Log in with any email**: an unknown email gets a 6-digit verification code
  and is walked into onboarding. Carbon signs up through the Supabase admin API
  (service-role key), which `GOTRUE_DISABLE_SIGNUP` does not block.

Both need working SMTP (step 3) to deliver the email.

## 8. Verify

```bash
curl -f https://erp.example.com/health
curl -f https://mes.example.com/health
curl -f https://supabase.example.com/auth/v1/health -H "apikey: $SUPABASE_ANON_KEY"
```

The gateway answers `401` on protected routes without an `apikey` header.

## 9. Backups

A complete backup is **two paired artifacts** — restore them together, never
one without the other:

- **`db.sql.gz`** — `pg_dump` of the whole database: business data, auth
  users, and the *storage metadata* (`storage.buckets` / `storage.objects`).
- **`storage.tar.gz`** — the `storage` Docker volume: the actual uploaded
  files (documents, avatars, 3D models) that the metadata points at. This
  stack runs Supabase Storage with `STORAGE_BACKEND: file`, so uploads live
  on this volume, not in Postgres.

Run on the VPS (auto-detects the Dokploy project from the running
`supabase/postgres` container; override with `PROJECT=<name>`):

```bash
./scripts/backup.sh
# -> ./backups/carbon-<timestamp>/{db.sql.gz,storage.tar.gz}
```

Schedule it nightly and ship the result off the VPS — a copy on the same
machine is not a backup:

```bash
# crontab -e  (02:17 nightly, keep 14 local days, then sync offsite)
17 2 * * * cd /path/to/carbon/contrib/deploying/dokploy && RETENTION_DAYS=14 BACKUP_DIR=/var/backups/carbon ./scripts/backup.sh && rclone sync /var/backups/carbon remote:carbon-backups
```

Restore:

```bash
# database — as supabase_admin: postgres may not change the auth and storage schemas
gunzip -c db.sql.gz | docker exec -i <project>-postgres-1 psql -U supabase_admin postgres
# storage volume
docker run --rm -v <project>_storage:/data -v "$PWD:/in:ro" alpine:3 \
  sh -c 'rm -rf /data/* && tar xzf /in/storage.tar.gz -C /data'
```

The database restore reports "already exists" errors for the auth, storage and
realtime schemas, which their services create on boot. The rows still load.

Test a restore at least once (e.g. into a scratch Dokploy project) — an
untested backup is not a backup.

## Upgrading

### From a deployment made before November 2026

This version changes three things that a Redeploy alone cannot do:

| Change | What you do |
|---|---|
| Postgres 15 → 17. Postgres 17 cannot open a Postgres 15 data volume. | Dump and restore (below). `pg-version-check` stops the deploy until you do. |
| Kong → Envoy. The `kong` service is now `gateway` (the repo's `kong.yml` is gone). | In Dokploy's Domains tab, move the `SUPABASE_URL` domain from `kong` to `gateway`, port `8000`. |
| New required variables. | Add `SUPAVISOR_SECRET_KEY_BASE`, `SUPAVISOR_VAULT_ENC_KEY` (step 1) and `SMTP_FROM`. Rename `CARBON_IMAGE_OPS` to `CARBON_IMAGE_BOOTSTRAP` if you set it. Remove `RESEND_DOMAIN`. Set `EDGE_VERIFY_JWT=true`. |

Do the Postgres move during a maintenance window. The dump must be restored
into an **empty** Postgres 17, before `migrate` runs. If `migrate` runs first,
the restore cannot overwrite the rows that migrations seed, and those tables
keep the defaults instead of your data.

1. In Dokploy, add the new variables and move the domain to `gateway`. Do
   **not** deploy yet.
2. On the VPS, in the compose directory
   (`/etc/dokploy/compose/<app-name>/code/contrib/deploying/dokploy`), with the
   **old** stack still running:

   ```bash
   PROJECT=<project>        # docker compose ls shows it
   # Dump the database, and archive the storage volume as well.
   ./scripts/backup.sh
   # Stop the stack, then remove ONLY Postgres's data volume.
   # The storage, redis and inngest volumes stay as they are.
   docker compose -p "$PROJECT" down
   docker volume rm "${PROJECT}_pgdata"
   ```

3. Still on the VPS, get the new revision and start **only** Postgres 17. On
   the empty volume, the first-init scripts set the role passwords and the
   Supavisor setup. Compose warns that the new variables are unset; Postgres
   does not use them.

   ```bash
   git pull
   docker compose -p "$PROJECT" up -d postgres
   until docker exec "${PROJECT}-postgres-1" pg_isready -h 127.0.0.1 -U postgres; do sleep 2; done
   gunzip -c backups/carbon-<timestamp>/db.sql.gz \
     | docker exec -i "${PROJECT}-postgres-1" psql -U supabase_admin postgres
   ```

   "already exists" errors for the auth, storage and realtime schemas are
   expected. The rows still load.

4. In Dokploy, **Deploy**. `migrate` applies only the migrations that the dump
   predates, then the seed rewrites the `config` row and the Inngest event URL.

Keep the backup until you have logged in and checked your data.

## Troubleshooting

**The deploy stops at `pg-version-check`** with `pgdata holds Postgres 15 data`
— the volume is from before the Postgres 17 move. Follow
[Upgrading](#upgrading). Do not delete the volume before you have a dump.

**`erp`/`mes` never start, and `migrate` is the last thing in the logs** — this
is the gate working as designed, not a hang. Something upstream of the apps
failed; read `migrate`'s logs to find out which:

```bash
docker compose logs migrate       # or open the service's logs in Dokploy
```

- A SQL error means a migration genuinely failed — fix it, don't bypass the
  gate. The apps are being kept off a half-migrated schema on purpose.
- `seed failed (attempt 10/10)` — the seed could not reach the API through the
  gateway. Check `gateway`, `gotrue` and `postgrest` logs, and that
  `SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` match `SUPABASE_JWT_SECRET`.
- `password authentication failed for user "supabase_admin"` means
  `postgres/01-roles.sh` never ran. It only runs on the **first** init of an
  empty `pgdata` volume, so a volume that was created before the roles script
  landed still has the image's default passwords. Confirm with
  `docker compose logs postgres | grep zz-carbon-01-roles`.
- No `migrate` logs at all means it never started: its own gate
  (`postgres` + `storage` healthy) hasn't been satisfied. Check those two
  services first.
- `Command "supabase" not found` (or `supabase: not found`) means `migrate` is
  running the served app image instead of the `bootstrap` one. The app image
  strips the supabase CLI; `migrate` must carry `build: *bootstrap-build`
  (i.e. `target: bootstrap`) and its own `CARBON_IMAGE_BOOTSTRAP` tag. If you
  pinned `CARBON_IMAGE_ERP`/`CARBON_IMAGE_BOOTSTRAP` to registry images, check
  they aren't both pointing at the app image.

**Supavisor fails with `password authentication failed for user "pgbouncer"`**
or `database "_supabase" does not exist` — `postgres/03-pooler.sh` did not run,
because the `pgdata` volume was initialised before it existed. The Postgres 17
upgrade above creates a fresh volume, so this only happens if the script was
skipped. Run it once by hand, then restart `supavisor`:

```bash
docker exec -i -e POSTGRES_USER=supabase_admin <project>-postgres-1 bash < postgres/03-pooler.sh
```

**`exec: "/carbon/bin/run.sh": permission denied`** on `postgres`, `supavisor`,
`gotrue`, `realtime`, `storage`, `meta`, or `studio` — `bin/run.sh` lost its
executable bit somewhere between git and the container. The same goes for
`envoy/docker-entrypoint.sh` on `gateway`. All the `.sh` files here are
committed mode `755`; a clone made on a filesystem that drops the bit (or a
`core.fileMode=false` checkout that re-committed them) breaks every service
that uses them as its `entrypoint`. Fix it in git rather than on the server,
or the next clone reintroduces it:

```bash
git update-index --chmod=+x contrib/deploying/dokploy/bin/run.sh contrib/deploying/dokploy/envoy/docker-entrypoint.sh
```

**No verification code or invite email arrives** — SMTP is not set or is
wrong. Check `GOTRUE_SMTP_*` and `SMTP_FROM`, then the `gotrue` and `erp` logs
right after a login attempt. To unblock testing without email delivery, set
`DISABLE_RESEND=1` on `erp` and redeploy. The verification code then appears
in the `erp` logs instead (not for production use).

**An edge function fails with `worker boot error: ... could not find an
appropriate entrypoint`** — on current versions of this recipe this should no
longer happen: the functions are baked into the `edge-runtime` image at build
time (`edge-runtime.Dockerfile`). It used to happen when the functions were
bind-mounted from the checkout: Docker only evaluates a bind mount when a
container is *created*, so an `edge-runtime` created before a `git pull`
populated those directories kept serving an empty, stale view of them
indefinitely. If you still see it (e.g. running an older revision), force
the container to recreate —

```bash
cd <dokploy-compose-checkout>/contrib/deploying/dokploy
docker compose up -d --force-recreate edge-runtime
```

then confirm with `docker exec <edge-runtime-container> ls -la
/home/deno/functions/<function-name>/` — it should show `index.ts`, not an
empty directory. On the baked-image version, a Redeploy rebuilds the image
and function code updates ship atomically with it.

**Deploy hangs during the app build (around `rendering chunks...`)** — the
VPS ran out of memory. Docker Compose builds `erp` and `mes` in parallel by
default, the app build is memory-hungry at its Vite chunk-rendering peak, and
the whole running stack is competing for the same RAM. Confirm with `free -h`
(no free memory/swap) and `dmesg | grep -iE "oom|killed process"`. Fix all
three of:

1. **Add swap** (once, persists across reboots):

   ```bash
   fallocate -l 8G /swapfile && chmod 600 /swapfile
   mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   sysctl vm.swappiness=10
   ```

2. **Build one image at a time** — set `COMPOSE_PARALLEL_LIMIT=1` in the
   application's environment (already in `.env.example`).
3. **Cap the build heap** — the compose file passes
   `NODE_OPTIONS: --max-old-space-size=4096` as a build arg (the Dockerfile's
   default assumes an ~8 GB build machine).

Builds get slower but complete. For frequent deploys on a small VPS, the
longer-term fix is building the images in CI (e.g. GitHub Actions → a
registry) and pointing the compose `image:` at them instead of `build:`.
