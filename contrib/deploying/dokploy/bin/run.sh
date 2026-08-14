#!/bin/sh
# Neutral ENTRYPOINT shim.
#
# A few upstream Supabase images (gotrue, realtime, storage, meta, studio,
# edge-runtime, postgres) are normally run with their default ENTRYPOINT
# and a specific CMD. contrib/deploying/simple-docker-caddy overrides
# ENTRYPOINT on these services to inject Docker Swarm secrets before exec'ing
# the real command. This recipe uses plain environment variables instead (no
# Swarm secrets), so there is nothing to inject — this shim just pins the
# same ENTRYPOINT position and execs its arguments unchanged, so the CMD
# lists below can be copied verbatim from the proven Swarm recipe.
set -eu
exec "$@"
