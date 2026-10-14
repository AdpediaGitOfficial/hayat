# syntax=docker/dockerfile:1
# Build:  docker build -t gh-accommodation .            (runtime image, last stage)
#         docker build --target migrate -t gh-migrate .  (one-shot migration runner)

FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- dependencies (cached until package*.json changes)
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---- Next.js production build (output: 'standalone')
FROM deps AS build
COPY . .
RUN npm run build

# ---- migration runner: SQL files + the TypeScript runner, no Next build needed.
# Runs as the privileged database role, separate from the app's restricted login.
FROM deps AS migrate
COPY tsconfig.json ./
COPY db ./db
COPY scripts ./scripts
COPY src/server/db/migrate.ts ./src/server/db/migrate.ts
CMD ["npm", "run", "db:migrate"]

# ---- runtime: only the standalone server, static assets and public files
FROM base AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
# Liveness only. /api/health also checks the database and is meant for readiness probes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/ || exit 1
CMD ["node", "server.js"]
