# syntax=docker/dockerfile:1

# =============================================================================
# Hardened, minimal, multi-stage Docker build.
#
# Security properties:
#   - Multi-stage: build tools never ship in the final image (smaller surface).
#   - Final stage runs as a NON-ROOT user (least privilege; container breakout
#     from an unprivileged user is harder).
#   - Slim base image; only the standalone server + its traced deps are copied.
#   - No secrets baked in: configuration is injected at runtime via env vars.
#   - Healthcheck wired to /api/health for orchestrator readiness.
#   - Pinned base image (digest pinning recommended in your own registry).
# =============================================================================

ARG NODE_VERSION=20.18.1

# ---- deps: install production-capable node_modules (cached layer) ----
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
# argon2 native build needs python3 + build toolchain in THIS stage only.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
# Use a reproducible install. (Generate a lockfile locally before building.)
RUN npm ci

# ---- builder: compile the Next.js standalone output ----
FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `prebuild` validates env, but at build time secrets are absent; provide
# build-only placeholders that satisfy the schema. These are NOT used at runtime.
# Real secrets are injected when the container RUNS, not when it is built.
ENV NODE_ENV=production \
    APP_ORIGIN=https://build.invalid \
    CORS_ALLOWED_ORIGINS=https://build.invalid \
    JWT_ACCESS_SECRET=build_time_placeholder_value_at_least_32_chars_aaaa \
    JWT_REFRESH_SECRET=build_time_placeholder_value_at_least_32_chars_bbbb \
    SESSION_SECRET=build_time_placeholder_value_at_least_32_chars_cccc \
    JWT_ISSUER=build \
    JWT_AUDIENCE=build
RUN npm run build

# ---- runner: minimal, non-root runtime ----
FROM node:${NODE_VERSION}-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Create an unprivileged user/group.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 --ingroup nodejs nextjs

# Copy ONLY what the standalone server needs.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

EXPOSE 3000

# Liveness/readiness check using Node's built-in fetch (no extra packages).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3000) +'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `server.js` is the entrypoint Next emits for standalone output. It boots the
# Node server (Node forwards SIGTERM to it; our instrumentation handles graceful
# shutdown). Run it directly as PID 1's child via exec form for proper signals.
CMD ["node", "server.js"]
