# App template — web + mobile on one backend

A running starting point for a new app: **Next.js on the web, Expo on the phone,
one typed API between them.** Clone it, run one script, sign in, and you have a
working full-stack app with multi-tenancy, background jobs, LLM plumbing and file
storage already wired.

```
apps/web         Next.js 16 (App Router) — the UI and the API
apps/mobile      Expo 57 (expo-router + NativeWind) — Expo Go, or a dev client / store build via EAS
apps/worker      BullMQ worker + cron schedules
apps/desktop     Tauri 2 desktop shell (Windows/macOS/Linux) around the web app
packages/api     tRPC routers — the single API surface, shared by both apps
packages/db      Prisma + Postgres
packages/auth    better-auth — email+password, Google OAuth, organizations
packages/ai      any OpenAI-compatible model, every call priced
packages/agent   agent runs with a human approval queue; MCP at /api/mcp
packages/domain  domain functions shared by the API and the agent's tools
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

Expo Go covers sign-in, items, photo upload and dictation. Push notifications
(and native modules) need a development build from EAS: `cd apps/mobile && npx
eas init && npx eas build --profile development`. See "Mobile" in CLAUDE.md.

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

## Email confirmation

Sign-up requires confirming the address, and it works with **no third-party
account**: `docker compose up -d mailpit` runs a real SMTP server locally, and
every message lands in its inbox at **http://localhost:8035**. Sign up, open the
inbox, click the link — you are verified and signed in.

`scripts/setup.sh` starts it, and the end-to-end suite reads the message out of
Mailpit's API and opens the real link, so the confirmation flow is part of the
merge gate rather than something you hope still works.

The suite uses a **second, throwaway catcher** (`mailpit-test`, ports 1036/8036),
never your dev inbox. Its links point at the gate's isolated port and stop working
when the run ends, so letting them pile up in your inbox would make working mail
look broken.

Testing from a phone? `localhost:8035` is not reachable from another device — put
the inbox behind a tunnel and point `DEV_MAIL_INBOX_URL` at it, so the "confirm
your email" screen links somewhere you can actually open.

Two honest limits:

- **Mailpit shows mail; it never delivers it onward.** It is an inbox for you and
  your tests, not for your users. To reach real inboxes, point `SMTP_*` at an
  SMTP relay. (Self-hosting an MTA that strangers' servers accept is a
  deliverability project — SPF, DKIM, DMARC, reputation — and outbound port 25 is
  usually blocked anyway.)
- **Verification links are built from `APP_URL`.** If that says `localhost` the
  link is unclickable on a phone. Set it to the origin your users actually reach.

With `SMTP_HOST` unset the message is printed to the server console instead, so a
fresh clone still runs and you can copy the link out of the terminal. Set
`REQUIRE_EMAIL_VERIFICATION=false` to let unconfirmed accounts sign in — but
that means anyone can register an address they do not own.

## Reaching it from anywhere (Tailscale)

Wifi works out of the box. To reach the app from off the LAN — and to get real
HTTPS, which Google OAuth requires for any non-localhost redirect — put it behind
Tailscale:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3200
tailscale serve status          # confirm you did not overwrite another mapping
```

That publishes `https://<machine>.<tailnet>.ts.net:8443`, tailnet-only, with a
valid certificate.

Two things must then be true:

- **Pick a port nothing else is serving.** `--https=443` is the obvious choice
  and also the one most likely already taken by another project on the same
  machine; `tailscale serve status` before and after is the check.
- **Add the origin to `TRUSTED_ORIGINS`** in `.env` (comma-separated), both the
  HTTPS name and the raw `http://<tailscale-ip>:3200` the phone uses. Without it
  every sign-in fails with "Invalid origin" — that check is a CSRF boundary, so
  add the origin rather than relaxing it. Recreate the containers afterwards
  (`docker compose --profile full up -d --force-recreate web worker`); `env_file`
  is read at container creation.

The same list also feeds the dev server's `allowedDevOrigins`: `next dev`
refuses its scripts to hosts it does not know, so a page opened on the Tailscale
name renders but never hydrates. Restart `make dev` after editing `.env` — the
Next config is read once at startup.

For the phone, start Expo advertising the Tailscale address and leave
`EXPO_PUBLIC_API_URL` empty — the app derives its API origin from whichever host
served the bundle, so the same build follows you between wifi and Tailscale:

```bash
REACT_NATIVE_PACKAGER_HOSTNAME=<tailscale-ip> npm run dev:mobile
```

`tailscale serve` is tailnet-only. `tailscale funnel` would expose it to the
public internet — do not reach for that to test a phone.

## Production

`docs/deploy.md` is the runbook for one Linux host running Docker. It covers:

- `scripts/deploy.sh`: health-gated deploys with automatic rollback
- nightly backups, and a `restore.sh` that has been tested
- a Cloudflare Tunnel or Tailscale in front, with no inbound ports

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
- **LLM calls that are auditable.** One API over Anthropic (official SDK),
  OpenAI, Azure, OpenRouter, DeepSeek, any OpenAI-compatible server (Ollama,
  vLLM) and Claude Code (`claude -p`, optionally via a host bridge for Docker),
  chosen per tier by a `provider/model` string in .env. Tokens (incl. cache),
  latency and USD cost go to `llm_call` per tenant and feature; a per-tenant
  daily cap refuses optional calls before they are sent. Structured output is
  zod-validated and never silently repaired.

  _Upgrading an existing `.env`:_ the old single-endpoint config keeps working.
  `LLM_BASE_URL` + `LLM_MODEL` (bare, or a slashed id like `openai/gpt-4o-mini`
  on OpenRouter) is read as a model id on that URL whenever the prefix's own
  provider has no key, and the boot log says so; write `local/<id>` to make it
  explicit. New: `LLM_DAILY_CAP_USD` (unset = $2/day as before; `off` to disable) and `LLM_PRICES` — a
  model with no price is refused for optional calls while a cap is set.

- **File uploads.** Content-type allow-list, size cap, tenant-namespaced keys,
  authenticated download. Local disk by default; S3/R2/MinIO by changing one
  variable.
- **A real gate.** `make smoke` builds for production, boots the standalone
  server and the worker against real Postgres and Redis, and drives the actual
  user journey (including a worker job) through Chromium. CI runs the same
  script plus the Docker builds.

## Making it yours

1. Rename: `APP_SCHEME`, `MOBILE_APP_NAME`, `MOBILE_APP_SLUG`,
   `MOBILE_BUNDLE_ID` and `EAS_PROJECT_ID` in `.env` (read by
   `apps/mobile/app.config.ts`; EAS environment variables for cloud builds), the `<title>` in
   `apps/web/src/app/layout.tsx`, `productName`/`mainBinaryName`/`identifier` in
   `apps/desktop/src-tauri/tauri.conf.json`.
2. Replace the demo `Item` model with your domain. Keep its `organizationId`
   column and index shape; `packages/api/src/routers/items.ts` is the reference.
3. Delete what you do not need — `packages/ai`, `packages/storage` and
   `packages/jobs` are independent.
4. Keep `make smoke` driving _your_ core journey.

Agents working in this repo should read [`CLAUDE.md`](./CLAUDE.md) — it is short
and it lists the traps.
