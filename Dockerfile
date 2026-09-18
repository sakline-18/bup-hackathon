# syntax=docker/dockerfile:1

FROM node:22-alpine AS base

# ---- deps: install dependencies only (cached separately from source) ----
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: compile the Next.js standalone build ----
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runner: minimal production image ----
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# `output: "standalone"` (next.config.ts) traces only the deps actually
# needed at runtime into .next/standalone, so the final image skips
# node_modules/devDependencies entirely.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
