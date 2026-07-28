# CLAUDE.md — orientation for an agent working in this repo

Read this whole file first; it is short on purpose. Do not go exploring to
answer questions it already answers.

## What this is

A **template**, not a product: the starting point for a web + mobile app. One
backend serves both surfaces over a typed API. Everything here already runs —
if something does not work, that is a bug, not an unfinished feature.

```
apps/web       Next.js 16 (App Router) — the UI *and* the API (/api/trpc, /api/auth)
apps/mobile    Expo 57 (expo-router + NativeWind) — iOS/Android via Expo Go
apps/worker    BullMQ worker + cron schedules (separate process on purpose)
packages/api   tRPC routers — the ONLY API surface, shared by web and mobile
packages/db    Prisma schema + client (Postgres)
packages/auth  better-auth: email+password, Google OAuth, organizations
packages/ai    LLM calls against any OpenAI-compatible endpoint, priced per call
packages/jobs  job registry + queue + schedules
packages/storage  file storage: local disk or any S3-compatible bucket
packages/env   the validated environment — import `env()`, never `process.env`
```

## First run

```bash
./scripts/setup.sh     # .env + deps + postgres/redis + migrations. Idempotent.
make dev               # web on :3200 + the worker
make mobile            # Expo dev server on :8091 — scan the QR with Expo Go
```

Sign up with any email and an 8+ character password. Google sign-in appears only
once `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set; email/password always works.

Ports are non-default so this coexists with other projects:
**web 3200 · postgres 5442 · redis 6389 · expo 8091**.

## The gates — run these before claiming anything works

```bash
make typecheck    # tsc --noEmit across every workspace
make lint
make test         # unit tests (vitest)
make smoke        # THE GATE: production build, booted, driven in a real browser
```

`make smoke` is the one that counts. Unit tests pass on an app that does not
boot; the smoke gate builds for production, boots the standalone server on an
isolated port against real Postgres and Redis, and drives sign-up → create →
reload → sign-out through Chromium. **Nothing is "done" until it is green.**

## Architecture rules (a reviewer should reject violations)

1. **The API is tRPC in `packages/api`.** Add a procedure there, not a Next route
   handler. Route handlers exist only for things tRPC cannot carry: auth
   (`/api/auth/[...all]`), file bytes (`/api/media/*`), health (`/api/health`).
2. **Tenant isolation lives in `orgProcedure`, not in resolvers.** Any query on
   an org-scoped table goes through `orgProcedure` and filters on
   `ctx.organizationId`. Mutations use `updateMany`/`deleteMany` with the org in
   the `where`, never `update`-by-id plus a separate ownership check.
3. **`env()` from `@repo/env`, never `process.env`.** It validates once and fails
   with a readable message. Node entrypoints start with `import "@repo/env/load"`.
4. **The model is config.** Any OpenAI-compatible endpoint works via
   `LLM_BASE_URL`/`LLM_MODEL`. Every call is priced into the `llm_call` table.
5. **Slow or failable work goes to `packages/jobs`**, not into a request. Every
   run is recorded in `job_run` — Redis is ephemeral, that table is not.
6. **Auth schema belongs to better-auth.** After changing plugins in
   `packages/auth`, run `npm run auth:schema` and diff before migrating.
7. **Shared packages export TypeScript source**, no build step. Next transpiles
   them (`transpilePackages`); Metro sees them via `watchFolders`.

## Things that will bite you (all learned here, the hard way)

- **`output: standalone` does not copy static assets.** Boot it without copying
  `.next/static` next to `server.js` and the app serves HTML, every JS chunk
  404s, nothing hydrates. `scripts/smoke.sh` and the Dockerfile both do it.
- **Never pin an absolute `baseURL` in the web auth client.** Same-origin is
  correct; a build-time origin breaks every preview URL, tunnel and test port.
- **"Invalid origin" on sign-in** means the origin is not in better-auth's
  `trustedOrigins`. Set `APP_URL` truthfully, or add to `TRUSTED_ORIGINS`
  (comma-separated). Do not loosen the check — it is a CSRF boundary.
- **"Too many requests" in tests** is the auth rate limiter doing its job. Raise
  `AUTH_RATE_LIMIT_MAX` for the load generator; never disable it.
- **A new account's first session has no `activeOrganizationId`** — sign-up
  creates the session before the membership exists. `orgProcedure` repairs it on
  first use; do not "fix" this by removing the fallback.
- **`localhost` is unreachable from a phone.** The mobile app derives your LAN
  address from the Expo dev server; `EXPO_PUBLIC_API_URL` only overrides it when
  it is not a loopback address.
- **Exposing it over Tailscale needs two steps, not one.** `tailscale serve` gives
  you the URL; the origin must also go into `TRUSTED_ORIGINS`, and the containers
  must be recreated (`env_file` is read at creation, not on restart). Check
  `tailscale serve status` first — another project on the machine may already own
  the port you were about to claim. See the README section for the exact commands.
- **`STORAGE_LOCAL_DIR` is relative to each process's cwd**, which differs per
  entrypoint. The resolved root is logged at startup. Use an absolute path to pin it.
- **tailwindcss v4 (web) and v3 (mobile, for NativeWind) coexist** deliberately.
  If PostCSS throws `Cannot read properties of undefined (reading 'All')`, the
  wrong major got hoisted — run a full `npm install`.
- Mobile has one `@ts-expect-error` on the better-auth Expo plugin: an upstream
  generic-variance gap in 1.6.25. Suppressed rather than cast so session types
  still infer. Remove it when upstream types line up.

## Starting a real app from this template

1. Rename: `expo.scheme` + `APP_SCHEME`, `expo.name`/`slug`, bundle identifiers
   in `apps/mobile/app.json`, the `<title>` in `apps/web/src/app/layout.tsx`.
2. Replace the `Item` model with your domain — keep its `organizationId` column
   and index shape. `packages/api/src/routers/items.ts` is the reference resolver.
3. Delete what you do not need. `packages/ai`, `packages/storage` and
   `packages/jobs` are independent; removing one touches only its imports.
4. Keep the smoke test honest: it should always drive _your_ core journey.

## Handing work to the software factory

This template is designed to be driven by `../software-factory` (see its
`CLAUDE.md`). To wire a new app built from it, copy `factory/config.yaml` to
`software-factory/apps/<app>/config.yaml` and adjust `repo`/`app_repo_path`. The
gate commands there are exactly the ones above, so the factory's merge gates and
your local gates cannot drift apart.
