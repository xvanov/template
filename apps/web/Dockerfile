# ── build ────────────────────────────────────────────────────────────────
# Built from the MONOREPO ROOT (see docker-compose.yml `context: .`): the web
# app depends on workspace packages that live outside apps/web.
FROM node:22-alpine AS builder
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

COPY . .

# `npm ci` from the committed lockfile — never `npm install` in an image, or the
# built artifact stops matching what was tested.
RUN npm ci --no-audit --fund=false
RUN npm run db:generate
RUN npm run build --workspace web

# ── run ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN apk add --no-cache openssl
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Next's `standalone` output already contains only the traced dependencies.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

# Local-driver uploads land here; mount a volume so they survive a redeploy.
RUN mkdir -p /app/storage && chown -R node:node /app/storage
USER node

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
