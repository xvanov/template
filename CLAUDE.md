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
packages/email  outbound SMTP (nodemailer), ONLY via the outbound guard. Mailpit locally
packages/outbound  the outbound guard: every email/SMS/push passes it and is logged
packages/security  rate limiting, cron/webhook auth, AES-GCM sealing of stored secrets
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
make test         # unit + integration tests (vitest). Needs Postgres: `make up`
make smoke        # THE GATE: production build, booted, driven in a real browser
```

`make test` runs two kinds of test. `*.test.ts` are unit tests: no database,
run anywhere. `*.int.test.ts` hit real Postgres: once per run,
`packages/db/testing/global-setup.ts` creates a throwaway schema `vt_<ts>_<hex>`
in the dev database, applies each migration's SQL into it in order (~40 ms in
all), and drops it afterwards; `public` is never touched. If Postgres is down
and the tests actually execute, the run FAILS with "start it with `make up`";
it never silently skips. Caveat: turbo replays a cached pass when nothing
changed, without running anything, so a green `make test` does not prove
Postgres is up. `npx turbo run test --force` re-runs for real.
`TEST_DATABASE_URL` points it at another database (CI does).
`npm run test:unit -w @repo/api` runs only the DB-free tests.

**Writing an org-isolation test** (do this for every new org-scoped model), in
`packages/api/test/<thing>.int.test.ts`; `tenant-isolation.int.test.ts` is the
reference:

```ts
const a = await createTenant("a"); // from @repo/db/testing: user+org+session
const b = await createTenant("b");
const row = await callerFor(a).things.create({ ... }); // ./caller: real router
expect(await callerFor(b).things.list()).toEqual([]);  // B sees nothing of A's
await expect(callerFor(b).things.remove({ id: row.id }))
  .rejects.toMatchObject({ code: "NOT_FOUND" });       // nor can B change it
```

Each `createTenant` is unique, so test files share the schema and still run in
parallel. Assert only on what a tenant can see; never on global row counts.

`make smoke` is the one that counts. Unit tests pass on an app that does not
boot; the smoke gate builds for production, boots the standalone server **and
the worker** on an isolated port against real Postgres and Redis, and drives
sign-up → create → reload → a worker job → sign-out through Chromium. It fails
if either process dies during boot or during the run, and prints the tail of
both logs on any failure. It runs **every** e2e test (no tag filter), so a new
test in `apps/web/e2e` is in the gate automatically. **Nothing is "done" until it is green.** CI runs
this same script (`.github/workflows/ci.yml`) — change the script, never
re-inline its steps in the workflow.

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
   run is recorded in `job_run` — Redis is ephemeral, that table is not. Each
   registry entry declares `scope: "org" | "system"`, and the compiler holds it
   to the payload schema: an org job's schema must have a required
   `organizationId: string`, a system job's must not have one. The worker stamps
   the run's owner from the validated payload; system runs are owned by nobody
   and shown to no tenant. A tenant's job whose org was deleted while queued is
   recorded as `skipped` and not run.
6. **Auth schema belongs to better-auth.** After changing plugins in
   `packages/auth`, run `npm run auth:schema` and diff before migrating.
7. **Shared packages export TypeScript source**, no build step. Next transpiles
   them (`transpilePackages`); Metro sees them via `watchFolders`.
8. **Every outbound message goes through the guard** (`deliver` in
   `packages/outbound`). Send email with `sendMail` from `@repo/email`; never
   import nodemailer or a provider SDK anywhere else (a test enforces it). A
   new channel (SMS, push) gets its own package that calls `deliver` and does
   not export its raw transport.
9. **Mutations write an audit event in the same transaction**:
   `ctx.db.$transaction(async (tx) => { ...; await ctx.audit("item.delete", { targetId }, tx) })`.
   `packages/api/src/routers/items.ts` is the reference.

## Outbound messages and safe mode

Exists because a production app emailed the wrong thing to 8 real customers.
`deliver()` runs these gates in order; the first that fails blocks the message:

1. channel switch `OUTBOUND_<EMAIL|SMS|PUSH>_ENABLED` (email on, others off)
2. kill switch: `OUTBOUND_FROZEN=true`, or at runtime with no restart:
   `npm run outbound:freeze -- on [email]` / `off` / `status` (stored in `app_setting`)
3. **safe mode**: ON by default everywhere except `NODE_ENV=production`. Only
   `OUTBOUND_SAFE_RECIPIENTS` (addresses, `@domain`, phone numbers) get real
   messages; everything else is blocked and logged. A staging box loaded with a
   copy of production data therefore cannot mail a customer.
4. suppression list (`outbound_suppression`: global for bounces, per-org for unsubscribes)
5. volume caps in Redis: per recipient/hour, per org/hour and /day, global/hour.
   Redis unreachable = **blocked** (fails closed).

Every attempt writes one `outbound_message` row, BEFORE the provider is
called, so nothing leaves without a record. Blocked sends resolve with
`status: "blocked"` (they do not throw); provider errors throw after being
recorded as `failed`. Tenants read their own rows via `activity.outbound`.

**Auth mail vs safe mode.** better-auth's verification mail is sent with
`sendAuthMail`, which is exempt from the safe-mode allowlist and nothing else.
The recipient just typed that address into the sign-up form, so it cannot be
"the wrong person", and without the exemption nobody could sign up on a dev or
staging box. The kill switch, suppression and the per-recipient cap still
apply. Use `sendAuthMail` for better-auth callbacks only. `make smoke` forces
safe mode ON with an empty allowlist, so the gate proves sign-up still works.

In development, app mail to anyone not in `OUTBOUND_SAFE_RECIPIENTS` is
blocked even though Mailpit would catch it. Allowlist your test domain
(`OUTBOUND_SAFE_RECIPIENTS=@example.com`) rather than turning safe mode off.

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
- **Sign-up requires email confirmation** (`REQUIRE_EMAIL_VERIFICATION`, on by
  default), so sign-up returns NO session. Code that assumes a session right
  after `signUp.email` is wrong — check `result.data.token` and show the
  "confirm your email" state. The e2e suite opens the real emailed link via
  Mailpit's API; `docker compose up -d mailpit` must be running for it.
- **Verification links are built from `APP_URL`.** A `localhost` value emails an
  unclickable link to a phone. Set it to the origin users actually reach.
- **The gate boots the worker, so a worker that crashes fails the merge.** It
  waits for the `[worker] up` line; keep that log line if you touch
  `apps/worker/src/index.ts`. The journey clicks "Summarise items in the
  worker" and waits for `✓ items.summarize`, so a job that fails or is never
  picked up is red too. The gate forces `LLM_API_KEY=""` (free, deterministic)
  and puts logs and `STORAGE_LOCAL_DIR` in a fresh `mktemp -d` dir, kept and
  printed on failure.
- **The Dockerfiles build from `turbo prune <app> --docker`**, so each image
  holds only its app and the workspace packages it imports, and `npm ci` runs
  on manifests alone (source edits reuse that layer). Prune does NOT carry
  root-level files: `tsconfig.base.json` is copied explicitly. A new root file
  the build needs must be added there too, or the image build fails.
- **The gate has its OWN mail catcher** (`mailpit-test`, :1036/:8036) separate
  from the dev inbox (:1035/:8035). Its links point at the gate's isolated port
  and die with the run, so mixing them into your inbox makes real mail look
  broken. Keep them apart.
- **`.env` is sourced with `set -a` at the top of smoke.sh**, so every variable in
  it is already exported by the time the server is launched. A
  `${SOME_VAR:-fallback}` default therefore NEVER applies — that is why the gate's
  overrides use distinct `SMOKE_*` names. Watch for this whenever you add one.
- **Quote `.env` values containing `< > | &`.** `scripts/smoke.sh` sources the
  file with `.`, and an unquoted `<` is a shell redirect — `SMTP_FROM` is the one
  that bites. dotenv strips the quotes, so both readers are satisfied.
- **Exposing it over Tailscale needs two steps, not one.** `tailscale serve` gives
  you the URL; the origin must also go into `TRUSTED_ORIGINS`, and the containers
  must be recreated (`env_file` is read at creation, not on restart). Check
  `tailscale serve status` first — another project on the machine may already own
  the port you were about to claim. See the README section for the exact commands.
- **`next dev` only reads `.env` from `apps/web/`**, but the one `.env` lives at
  the root — so a bare `next dev` fails every render with "Invalid environment".
  `apps/web/scripts/with-root-env.mjs` loads the root file first (set variables
  win); the `dev`/`start` scripts go through it. The smoke gate never sees this
  because it exports everything itself. Do not "fix" it with a symlink.
- **The dev server blocks its own scripts on unknown hosts**, so a page opened
  over Tailscale or a LAN IP renders but never hydrates (forms submit as GET).
  `allowedDevOrigins` in `next.config.ts` is derived from the hostnames in
  `APP_URL` + `TRUSTED_ORIGINS` — add the origin there and restart `make dev`.
- **`STORAGE_LOCAL_DIR` is relative to each process's cwd**, which differs per
  entrypoint. The resolved root is logged at startup. Use an absolute path to pin it.
- **tailwindcss v4 (web) and v3 (mobile, for NativeWind) coexist** deliberately.
  If PostCSS throws `Cannot read properties of undefined (reading 'All')`, the
  wrong major got hoisted — run a full `npm install`.
- **"I sent an email and nothing arrived"**: look in `outbound_message` first.
  The row says whether it was sent, or which gate blocked it and why. The guard
  also prints `[outbound] BLOCKED ...` to the log.
- **Two Redis connections on purpose.** BullMQ's (packages/jobs) has no command
  timeout because workers block; the request-path one (packages/security) has a
  2s timeout so rate limits and caps fail fast. Do not merge them.
- **Rate limits fail open, outbound caps fail closed.** A limit that protects
  our capacity (`rateLimited` tRPC middleware) lets traffic through when Redis
  is down; one that protects other people (outbound caps) blocks. The counter
  store is in-memory only under `NODE_ENV=test`.
- **Machine-to-machine endpoints fail closed.** `requireCronAuth` /
  `verifyHmac` from `@repo/security` refuse every request in production when
  their secret is unset (outside production an unset secret is allowed).
  Third-party tokens at rest go through `sealSecret`/`openSecret`.
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
