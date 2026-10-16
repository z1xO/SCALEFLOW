# syntax=docker/dockerfile:1
# One image for every backend process; docker-compose / your orchestrator picks the command:
#   node dist/processes/api.js | worker.js | relay.js | scheduler.js | node dist/cli/migrate.js
# Build from the repository root:  docker build -f apps/server/Dockerfile -t scaleflow-server .

FROM node:24.21.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --workspace @scaleflow/server --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY apps/server apps/server
RUN npm run build --workspace @scaleflow/server

FROM node:24.21.0-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --workspace @scaleflow/server --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.21.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY apps/server/migrations ./apps/server/migrations
COPY apps/server/package.json ./apps/server/package.json
WORKDIR /app/apps/server
USER node
EXPOSE 4000 9465 9466 9467
# Node is PID 1 here; ScaleFlow installs SIGTERM/SIGINT handlers itself (graceful shutdown).
# Run with `init: true` (compose) or `--init` to reap zombies.
CMD ["node", "dist/processes/api.js"]
