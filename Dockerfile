# syntax=docker/dockerfile:1

# Hive — single-origin gateway (SQLite kernel + Vite SPA + outbox worker).
# Single-machine deploy: one process, one volume for .hive/ state.
# This image is a build artifact, NOT a deployment: going live needs the
# owner's gateway-host decision + go-ahead (see TODO.md §4 / INFRASTRUCTURE.md).

# ── Build stage: install ALL deps, type-check, build SPA bundle + SDK ────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build   # tsc --noEmit + build:sdk + vite build

# ── Runtime stage: production deps only ──────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HIVE_DB_PATH=/data/live.db \
    HIVE_STATIC_DIR=/app/dist \
    HIVE_ARTIFACT_DIR=/data/artifacts
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-sdk ./dist-sdk
COPY --from=build /app/src ./src
COPY --from=build /app/db ./db
# Non-root; /data holds SQLite + WAL + artifacts (mount a volume here).
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Required at runtime (no defaults, by design — the server refuses to boot):
#   HIVE_ADMIN_TOKEN   (>=32 chars)
#   HIVE_MASTER_KEY    (openssl rand -base64 32)
# Optional: HIVE_GITHUB_* / HIVE_SLACK_* / HIVE_GATEWAY_TOKEN / webhook secrets.
CMD ["node", "--no-warnings", "--import", "tsx", "src/server/index.ts"]
