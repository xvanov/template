# App template — web + mobile on one backend

A running starting point for a new app: **Next.js on the web, Expo on the phone,
one typed API between them.** Clone it, run one script, sign in, and you have a
working full-stack app with multi-tenancy, background jobs, LLM plumbing and file
storage already wired.

```
apps/web         Next.js 16 (App Router) — the UI and the API
apps/mobile      Expo 57 (expo-router + NativeWind) — iOS/Android via Expo Go
apps/worker      BullMQ worker + cron schedules
packages/api     tRPC routers — the single API surface, shared by both apps
packages/db      Prisma + Postgres
packages/auth    better-auth — email+password, Google OAuth, organizations
packages/ai      any OpenAI-compatible model, every call priced
packages/jobs    job registry, queue, schedules
packages/storage local disk or any S3-compatible bucket
packages/env     the validated environment
```

## Quickstart

Needs **Node ≥ 22** and **Docker**.

```bash
git clone <this repo> my-app && cd my-app
./scripts/setup.sh        # .env + deps + postgres/redis + migrations
make dev                  # → http://localhost:3200
```

Sign up with any email and an 8+ character password. You get your own workspace,
a list you can add to, an upload box, an AI box and a button that hands work to
the background worker.

On your phone:

```bash
make mobile               # Expo dev server, then scan the QR code with Expo Go
```

The mobile app finds your machine automatically (it derives the LAN address from
the Expo dev server), so the phone talks to the same backend as the browser.

## Everything else

```bash
make            # list every target
make smoke      # the gate: production build, booted, driven in a real browser
make test       # unit tests
make typecheck  # tsc --noEmit everywhere
make stack      # run the whole thing in Docker instead (web + worker + db + redis)
make db-migrate # create + apply a migration after editing the Prisma schema
make studio     # browse the database
```

Ports are deliberately non-default so this coexists with your other projects:
**web 3200 · postgres 5442 · redis 6389 · expo 8091**.

## Google sign-in

Optional — email/password works with no external setup. To enable it, create an
OAuth client at
[console.cloud.google.com](https://console.cloud.google.com/apis/credentials)
(type: Web application), add these redirect URIs, and put the two values in
`.env`:

```
http://localhost:3200/api/auth/callback/google
<your public https origin>/api/auth/callback/google
```

The mobile app reuses the same client through the `apptemplate://` deep link, so
there is nothing extra to configure for the phone.

## What is already handled

- **Multi-tenancy from row one.** Every user gets an organization on sign-up;
  every org-scoped query runs through `orgProcedure`, which supplies the tenant.
  An end-to-end test asserts one tenant cannot see another's rows.
- **Auth that works on both surfaces.** One better-auth server; the web client
  uses cookies, the Expo client keeps its session in the OS keychain.
- **Background work.** Redis-backed queue, cron schedules, and a durable
  `job_run` record — so a job that silently vanished is still visible.
- **LLM calls that are auditable.** Provider-agnostic (OpenAI, Azure, DeepSeek,
  OpenRouter, Groq, Ollama — it is a URL), with tokens, latency and USD cost
  written to `llm_call` per tenant and per feature, plus a daily spend ceiling.
- **File uploads.** Content-type allow-list, size cap, tenant-namespaced keys,
  authenticated download. Local disk by default; S3/R2/MinIO by changing one
  variable.
- **A real gate.** `make smoke` builds for production, boots the standalone
  server against real Postgres and Redis, and drives the actual user journey
  through Chromium. CI runs the same thing plus the Docker builds.

## Making it yours

1. Rename: `expo.scheme` + `APP_SCHEME`, `expo.name`/`slug` and the bundle
   identifiers in `apps/mobile/app.json`, the `<title>` in
   `apps/web/src/app/layout.tsx`.
2. Replace the demo `Item` model with your domain. Keep its `organizationId`
   column and index shape; `packages/api/src/routers/items.ts` is the reference.
3. Delete what you do not need — `packages/ai`, `packages/storage` and
   `packages/jobs` are independent.
4. Keep `make smoke` driving _your_ core journey.

Agents working in this repo should read [`CLAUDE.md`](./CLAUDE.md) — it is short
and it lists the traps.
