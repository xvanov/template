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
FROM base AS deps
COPY --from=prune /app/out/json/ ./
COPY --from=prune /app/out/full/packages/db/prisma.config.ts ./packages/db/
COPY --from=prune /app/out/full/packages/db/prisma/schema.prisma ./packages/db/prisma/
RUN npm ci --no-audit --fund=false \
  # The worker runs its TypeScript through tsx — no bundling step to keep in
  # sync — so the runtime needs production dependencies only.
  && npm prune --omit=dev --no-audit --fund=false

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
