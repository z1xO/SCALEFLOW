# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f apps/dashboard/Dockerfile --build-arg NEXT_PUBLIC_API_URL=http://localhost:4000 -t scaleflow-dashboard .
# NEXT_PUBLIC_* values are compiled into the browser bundle, so the API URL is a build argument.

FROM node:26.11.1-alpine AS build
WORKDIR /app
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --workspace @scaleflow/dashboard --include-workspace-root --no-audit --no-fund
COPY apps/dashboard apps/dashboard
RUN npm run build --workspace @scaleflow/dashboard

FROM node:26.11.1-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/dashboard/.next/standalone ./
COPY --from=build /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]
