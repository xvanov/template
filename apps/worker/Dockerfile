# Built from the MONOREPO ROOT (see docker-compose.yml `context: .`).
FROM node:22-alpine AS builder
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

COPY . .
RUN npm ci --no-audit --fund=false
RUN npm run db:generate

# The worker runs its TypeScript through tsx — no bundling step to keep in sync
# with the web build. Prune dev dependencies the runtime does not need.
RUN npm prune --omit=dev --workspaces --include-workspace-root || true

FROM node:22-alpine AS runner
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app ./
RUN mkdir -p /app/storage && chown -R node:node /app/storage
USER node

CMD ["npm", "run", "start", "--workspace", "worker"]
