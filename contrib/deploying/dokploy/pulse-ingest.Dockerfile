# The Pulse ingest service (apps/pulse-ingest): one long-lived MQTT
# subscriber that stores what Pulse devices send. Build context is the repo
# root, like edge-runtime.Dockerfile.
#
# The service imports only TYPES from @carbon/database, so it needs no build:
# tsx runs the TypeScript as it is. The install still links the workspace
# package, so its package.json comes along; nothing else of it is used.
FROM node:24.22.1-slim AS deps
WORKDIR /repo
RUN corepack enable
ENV npm_config_store_dir=/pnpm/store
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches
COPY packages/config/package.json ./packages/config/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY apps/pulse-ingest ./apps/pulse-ingest
# --ignore-scripts keeps out the root postinstall (it needs turbo and the whole
# repo) and the supabase CLI download of @carbon/database.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod --ignore-scripts --filter pulse-ingest

FROM node:24.22.1-slim AS runner
ENV NODE_ENV=production
ENV TZ=UTC
COPY --from=deps /repo /repo
WORKDIR /repo/apps/pulse-ingest
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]
