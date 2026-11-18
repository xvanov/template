# Built from the MONOREPO ROOT (see docker-compose.yml `context: .`).
#
# Layer order is the whole point of this file:
#   1. `turbo prune worker --docker` cuts the monorepo down to the worker and the
#      workspace packages it imports (no web, no Expo), and splits it into
#      manifests (out/json) and sources (out/full).
#   2. `npm ci` runs on the manifests alone, so a source-only edit reuses the
#      install layer instead of reinstalling ~1.4GB of every app's dependencies.
#   3. Sources are copied last.
# New workspace packages need no edit here — prune discovers them.

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# turbo at the exact version the lockfile pins. Only re-runs when the lockfile
# changes, so it costs nothing on a normal rebuild.
FROM base AS turbo
COPY package-lock.json ./
RUN npm install -g "turbo@$(node -p "require('./package-lock.json').packages['node_modules/turbo'].version")" \
  && rm package-lock.json

FROM turbo AS prune
COPY . .
RUN turbo prune worker --docker

# Install from manifests + the Prisma schema only (the root postinstall runs
# `prisma generate`, which needs the schema and config — nothing else).
FROM base AS install
COPY --from=prune /app/out/json/ ./
COPY --from=prune /app/out/full/packages/db/prisma.config.ts ./packages/db/
COPY --from=prune /app/out/full/packages/db/prisma/schema.prisma ./packages/db/prisma/
RUN npm ci --no-audit --fund=false

# ── migrate: the one-shot `prisma migrate deploy` image ─────────────────────
# Used by the production compose file's `migrate` service. The Prisma CLI is a dev
# dependency, which the runtime image below prunes away, so migrations run from
# the full install instead (it shares this file's cached `npm ci` layer, so it
# costs no extra install). Build it with `--target migrate`.
FROM install AS migrate
ENV NODE_ENV=production
COPY --from=prune /app/out/full/packages/db/prisma ./packages/db/prisma
WORKDIR /app/packages/db
USER node
# The collation guard first (prisma/ops/collation-guard.sql): if the database
# image changed its C library, text indexes are rebuilt before anything runs
# on them — even on a host whose deploy.sh predates that check. A no-op query
# otherwise. If the rebuild fails, migrate fails, and web/worker are not started.
CMD ["sh", "-c", "npx --no-install prisma db execute --file prisma/ops/collation-guard.sql && exec npx --no-install prisma migrate deploy"]

# The worker runs its TypeScript through tsx — no bundling step to keep in
# sync — so the runtime needs production dependencies only.
FROM install AS deps
RUN npm prune --omit=dev --no-audit --fund=false

FROM node:22-alpine AS runner
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app ./
# Root files prune does not carry: the shared tsconfig every package extends.
COPY tsconfig.base.json ./
COPY --from=prune /app/out/full/ ./
RUN mkdir -p /app/storage && chown -R node:node /app/storage
USER node

CMD ["npm", "run", "start", "--workspace", "worker"]
