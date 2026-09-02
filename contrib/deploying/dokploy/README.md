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
| `docker-compose.yml` | `erp` + `mes` (built from the repo's root `Dockerfile`), a one-shot `migrate` job that gates them (built from the same Dockerfile's `ops` stage), a full self-hosted Supabase, `redis`, and `inngest`. |
| `edge-runtime.Dockerfile` | Bakes the edge functions into the `edge-runtime` image (bind mounts proved fragile — see Troubleshooting). |
| `.env.example` | Template for every environment variable the compose file needs. |
| `bin/run.sh` | Neutral `exec "$@"` entrypoint shim — lets several Supabase images' proven CMD arrays be reused unchanged without Swarm secrets. |
| `postgres/01-roles.sh`, `postgres/02-performance.sh` | Postgres role bootstrap and tuning, run once on first init. |
| `scripts/gen-supabase-keys.sh` | Generates the Supabase JWT key trio (openssl only). |
| `scripts/backup.sh` | Nightly-able backup: Postgres dump + storage volume archive. |

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

Trigger a deploy in Dokploy. It builds the `erp` image from the repo's root
`Dockerfile`, builds `mes`, builds the small `ops` image the `migrate` job
below runs (a cache hit off the erp build — it stops before the app bundle),
and pulls the pinned Supabase/Redis/Inngest images.

## 6. Database migrations (automatic)

**You don't run these by hand.** The compose file has a one-shot `migrate`
service that applies pending migrations on every deploy, and `erp`/`mes` gate
on it via `depends_on: condition: service_completed_successfully`. The order
is always:

```
postgres + storage healthy  →  migrate runs to completion  →  erp + mes start
```

That ordering is the point: app code never boots against a schema that hasn't
caught up to it, and a failed migration aborts the deploy loudly instead of
leaving the apps serving against a stale schema. It mirrors what
[`../simple-docker-caddy`](../simple-docker-caddy) does with a Swarm
`--mode replicated-job` (`deploy.sh` → `cmd_migrate` → "Rolling apps now that
the schema exists").

The job runs the root `Dockerfile`'s `ops` stage, built from the same context
and revision as `erp`, so the schema and the code that assumes it can never
come from different revisions. It is a separate image from the one `erp`
serves because the served `runner` stage deliberately strips the supabase CLI
(along with esbuild, tar and npm) to keep build-tool CVEs out of the image
that faces the internet; `ops` is the un-hardened stage kept for exactly these
short-lived one-off jobs. `supabase migration up` only applies what's missing,
so a deploy with no new migrations finishes in about a second.

**The first deploy is the slow one** — there are ~930 migrations to apply and
it takes several minutes. Watch the `migrate` service's logs in Dokploy. If
your deploy times out before it finishes, apply them once manually (below),
then redeploy — subsequent runs only have to apply what's new.

### Running migrations by hand

Still useful for bootstrapping a slow first run, or for debugging. `postgres`
isn't published outside the Docker network and Kong only proxies HTTP
(auth/rest/storage/realtime) — it can't carry a raw Postgres connection — so
this has to run from *inside* the compose network:

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

That runs the migration in a fresh container on the stack's own network with
the same env the deploy uses — no password to paste — and is safe to repeat:
`migration up` only applies what is missing.

To drive the CLI yourself, run it in the **ops** image, not `erp` — the served
app image strips the Supabase CLI:

```bash
docker compose -p <project> run --rm --entrypoint sh migrate -c '
  PGSSLMODE=disable pnpm exec supabase migration up --include-all \
    --db-url "postgresql://supabase_admin:<POSTGRES_PASSWORD>@postgres:5432/postgres?sslmode=disable"
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
`./scripts/backup.sh` (step 8) *before* deploying schema changes, not just
nightly. Write migrations expand-then-contract — add the new column, ship code
that writes both, backfill, and only drop the old one in a later deploy — so
the old containers keep working during the window where both are alive.

## 7. Verify

```bash
curl -f https://erp.example.com/health
curl -f https://mes.example.com/health
curl -f https://supabase.example.com/auth/v1/health
```

## 8. Backups

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
# database
gunzip -c db.sql.gz | docker exec -i <project>-postgres-1 psql -U postgres postgres
# storage volume
docker run --rm -v <project>_storage:/data -v "$PWD:/in:ro" alpine:3 \
  sh -c 'rm -rf /data/* && tar xzf /in/storage.tar.gz -C /data'
```

Test a restore at least once (e.g. into a scratch Dokploy project) — an
untested backup is not a backup.

Then log in at `https://erp.example.com/login` with the email you want as the
first admin — there's no separate account-bootstrap script. An unknown email
gets a 6-digit verification code (sent via `RESEND_API_KEY`, so that must be
set) and is walked into the onboarding wizard, which creates the first
company and makes that user its owner. `GOTRUE_DISABLE_SIGNUP=true` does not
block this — Carbon's signup goes through the Supabase admin API
(service-role key), a separate path from GoTrue's public self-service signup.

## Troubleshooting

**`erp`/`mes` never start, and `migrate` is the last thing in the logs** — this
is the gate working as designed, not a hang. Something upstream of the apps
failed; read `migrate`'s logs to find out which:

```bash
docker compose logs migrate       # or open the service's logs in Dokploy
```

- A SQL error means a migration genuinely failed — fix it, don't bypass the
  gate. The apps are being kept off a half-migrated schema on purpose.
- `password authentication failed for user "supabase_admin"` means
  `postgres/01-roles.sh` never ran. It only runs on the **first** init of an
  empty `pgdata` volume, so a volume that was created before the roles script
  landed still has the image's default passwords. Confirm with
  `docker compose logs postgres | grep zz-carbon-01-roles`.
- No `migrate` logs at all means it never started: its own gate
  (`postgres` + `storage` healthy) hasn't been satisfied. Check those two
  services first.
- `Command "supabase" not found` (or `supabase: not found`) means `migrate` is
  running the served app image instead of the `ops` one. The app image strips
  the supabase CLI; `migrate` must carry `build: *ops-build` (i.e.
  `target: ops`) and its own `CARBON_IMAGE_OPS` tag. If you pinned
  `CARBON_IMAGE_ERP`/`CARBON_IMAGE_OPS` to registry images, check they aren't
  both pointing at the app image.

**`exec: "/carbon/bin/run.sh": permission denied`** on `postgres`, `gotrue`,
`realtime`, `storage`, `meta`, or `studio` — `bin/run.sh` lost its executable
bit somewhere between git and the container. All the `.sh` files here are
committed mode `755`; a clone made on a filesystem that drops the bit (or a
`core.fileMode=false` checkout that re-committed them) breaks every service
that uses the shim as its `entrypoint`. Fix it in git rather than on the
server, or the next clone reintroduces it:

```bash
git update-index --chmod=+x contrib/deploying/dokploy/bin/run.sh
```

**"Failed to send verification code" on first login** — `RESEND_API_KEY` is
missing/invalid, or `RESEND_DOMAIN` isn't a verified sending domain in your
Resend account. Check the `erp` container logs right after a login attempt
for the underlying Resend error. To unblock testing without email delivery,
set `DISABLE_RESEND=1` on `erp` and redeploy — the verification code gets
printed to the `erp` logs instead of emailed (not for production use, since
other features like user invites also go through Resend).

**An edge function fails with `worker boot error: ... could not find an
appropriate entrypoint`** (e.g. onboarding's "Fatal: failed to seed company")
— on current versions of this recipe this should no longer happen: the
functions are baked into the `edge-runtime` image at build time
(`edge-runtime.Dockerfile`). It used to happen when the functions were
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
