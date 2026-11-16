# ── build ────────────────────────────────────────────────────────────────
# Built from the MONOREPO ROOT (see docker-compose.yml `context: .`): the web
# app depends on workspace packages that live outside apps/web.
#
# Layer order is the whole point (same scheme as apps/worker/Dockerfile):
# `turbo prune web --docker` cuts the monorepo down to web + the packages it
# imports (no Expo), split into manifests (out/json) and sources (out/full);
# `npm ci` runs on the manifests alone, so a source-only edit reuses the
# install layer. New workspace packages need no edit here — prune finds them.
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# turbo at the exact version the lockfile pins (re-runs only on a lockfile change).
FROM base AS turbo
COPY package-lock.json ./
RUN npm install -g "turbo@$(node -p "require('./package-lock.json').packages['node_modules/turbo'].version")" \
  && rm package-lock.json

FROM turbo AS prune
COPY . .
RUN turbo prune web --docker

# `npm ci` from the committed (pruned) lockfile — never `npm install` in an
# image, or the built artifact stops matching what was tested. The root
# postinstall runs `prisma generate`, so the schema + config come along.
FROM base AS builder
COPY --from=prune /app/out/json/ ./
COPY --from=prune /app/out/full/packages/db/prisma.config.ts ./packages/db/
COPY --from=prune /app/out/full/packages/db/prisma/schema.prisma ./packages/db/prisma/
RUN npm ci --no-audit --fund=false
# Root files prune does not carry: the shared tsconfig every package extends.
COPY tsconfig.base.json ./
COPY --from=prune /app/out/full/ ./
RUN npm run build --workspace web && mkdir -p apps/web/public

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
# Same as scripts/smoke.sh: public/ is not traced either (created empty if absent).
COPY --from=builder /app/apps/web/public ./apps/web/public

# Local-driver uploads land here; mount a volume so they survive a redeploy.
RUN mkdir -p /app/storage && chown -R node:node /app/storage
USER node

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
