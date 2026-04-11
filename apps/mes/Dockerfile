FROM node:20.20 AS deps
WORKDIR /repo
# Install specific npm version
RUN npm install -g npm@10.8.2
# Copy root manifests for workspaces
COPY package.json package-lock.json turbo.json lingui.config.js ./
# Copy only what we need to install and build
COPY apps ./apps
COPY packages ./packages
# Install all workspaces (dev deps are needed to build)
RUN npm install --legacy-peer-deps

FROM deps AS build
ARG NODE_OPTIONS
ENV NODE_OPTIONS=${NODE_OPTIONS:-"--max-old-space-size=4096"}
# Build only MES and its deps
RUN npx lingui compile --namespace es
RUN npx turbo run build --filter=./apps/mes

FROM node:20-slim
WORKDIR /repo
# Install specific npm version
RUN npm install -g npm@10.8.2
ENV NODE_ENV=production
ENV PORT=3000
# Install curl for health checks
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
# Production needs built app, node_modules, and packages (for workspace deps)
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages ./packages
COPY --from=build /repo/apps/mes ./apps/mes
EXPOSE 3001
WORKDIR /repo/apps/mes
CMD ["npm","run","start"]