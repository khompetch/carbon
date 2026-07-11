#!/usr/bin/env bash
# Back up the Carbon Dokploy stack: a Postgres logical dump + the storage volume.
#
#   ./scripts/backup.sh                          # -> ./backups/carbon-<timestamp>/
#   BACKUP_DIR=/mnt/backups ./scripts/backup.sh
#   PROJECT=my-project ./scripts/backup.sh       # skip auto-detection
#   RETENTION_DAYS=14 ./scripts/backup.sh        # prune local backups older than 14 days
#
# What it captures (the two halves of a complete backup — they must stay paired):
#   db.sql.gz       — pg_dump of the whole database: business data, auth users,
#                     AND the storage metadata (storage.buckets / storage.objects).
#   storage.tar.gz  — the `storage` Docker volume: the actual uploaded files
#                     (documents, avatars, models) that the metadata points at.
#
# Restore (DB):
#   gunzip -c db.sql.gz | docker exec -i <project>-postgres-1 psql -U postgres postgres
# Restore (storage volume):
#   docker run --rm -v <project>_storage:/data -v "$PWD:/in:ro" alpine:3 \
#     sh -c 'rm -rf /data/* && tar xzf /in/storage.tar.gz -C /data'
#
# Run from cron for regular backups, and ship the backup dir offsite
# (S3/rclone/another machine) — a copy on the same VPS is not a backup.
# Test a restore at least once; an untested backup is not a backup.
set -euo pipefail

log() { printf '\033[0;36m[backup]\033[0m %s\n' "$*"; }
err() { printf '\033[0;31m[backup]\033[0m %s\n' "$*" >&2; exit 1; }

# ── Locate the Dokploy compose project ────────────────────────────────────────
# Dokploy names compose containers `<project>-<service>-<n>`. Find the Supabase
# postgres container and derive the project from it, unless PROJECT is given.
if [ -z "${PROJECT:-}" ]; then
    PG_CONTAINER="$(docker ps --format '{{.Names}}\t{{.Image}}' \
        | awk -F'\t' '$2 ~ /^supabase\/postgres/ && $1 ~ /-postgres-[0-9]+$/ {print $1; exit}')"
    [ -n "$PG_CONTAINER" ] || err "no running supabase/postgres container found — pass PROJECT=<dokploy-project-name> explicitly"
    PROJECT="${PG_CONTAINER%-postgres-*}"
else
    PG_CONTAINER="${PROJECT}-postgres-1"
    docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER" \
        || err "container $PG_CONTAINER is not running"
fi

STORAGE_VOLUME="${PROJECT}_storage"
docker volume inspect "$STORAGE_VOLUME" >/dev/null 2>&1 \
    || err "volume $STORAGE_VOLUME not found — is PROJECT=\"$PROJECT\" correct?"

log "Project: $PROJECT (postgres: $PG_CONTAINER, storage volume: $STORAGE_VOLUME)"

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="${BACKUP_DIR:-./backups}"
OUT_DIR="$BACKUP_ROOT/carbon-$TS"
mkdir -p "$OUT_DIR"

# ── 1. Postgres logical dump (password comes from the container's own env) ────
log "Dumping database -> db.sql.gz"
docker exec "$PG_CONTAINER" sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U postgres -Fp postgres' \
    | gzip >"$OUT_DIR/db.sql.gz"

# ── 2. Storage objects (Supabase file backend — the uploaded files) ───────────
log "Archiving storage volume -> storage.tar.gz"
docker run --rm \
    -v "$STORAGE_VOLUME:/data:ro" \
    -v "$(cd "$OUT_DIR" && pwd):/out" \
    alpine:3 sh -c 'tar czf /out/storage.tar.gz -C /data .'

# ── 3. Optional local retention ────────────────────────────────────────────────
if [ -n "${RETENTION_DAYS:-}" ]; then
    log "Pruning local backups older than $RETENTION_DAYS days"
    find "$BACKUP_ROOT" -maxdepth 1 -type d -name 'carbon-*' \
        -mtime +"$RETENTION_DAYS" -exec rm -rf {} +
fi

log "Backup complete: $OUT_DIR"
ls -lh "$OUT_DIR"
