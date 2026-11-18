# CLAUDE.md — orientation for an agent working in this repo

Read this whole file first; it is short on purpose. Do not go exploring to
answer questions it already answers.

## What this is

A **template**, not a product: the starting point for a web + mobile app. One
backend serves both surfaces over a typed API. Everything here already runs —
if something does not work, that is a bug, not an unfinished feature.

```
apps/web       Next.js 16 (App Router) — the UI *and* the API (/api/trpc, /api/auth)
apps/mobile    Expo 57 (expo-router + NativeWind) — Expo Go, or a dev client / store build via EAS
apps/worker    BullMQ worker + cron schedules (separate process on purpose)
apps/desktop   Tauri 2 shell (Win/macOS/Linux) around the DEPLOYED web app. Rust;
               its own CI workflow; no turbo task touches it. apps/desktop/README.md
packages/api   tRPC routers — the ONLY API surface, shared by web and mobile
packages/db    Prisma schema + client (Postgres)
packages/auth  better-auth: email+password, Google OAuth, organizations
packages/ai    LLM calls routed by `provider/model` (Anthropic, OpenAI, Azure, local, Claude Code), priced + capped
packages/jobs  job registry + queue + schedules
packages/agent  agent runs: read tools run, write tools become proposals a person approves
packages/domain  domain functions (input rules + writes) shared by tRPC routers and agent tools
packages/rag   documents: chunk → embed → pgvector + Postgres FTS → hybrid search (RRF) → cited answers
packages/evals  eval harness: golden sets, graders, retrieval metrics, baselines (`npm run eval`)
packages/storage  file storage: local disk or any S3-compatible bucket
packages/email  outbound email (SMTP by default, or Resend), ONLY via the outbound guard. Mailpit locally
packages/sms   outbound SMS (Twilio), ONLY via the outbound guard. Off by default
packages/push-mobile  push to the mobile app (Expo push → APNs/FCM), ONLY via the outbound guard. Off by default
packages/inbound  messages that ARRIVE (email, SMS): routed to a tenant, stored, finished by the worker
packages/outbound  the outbound guard: every outbound message passes it and is logged
packages/notify  operator alerts (ntfy push, else email, else console), deduped + digested
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

`next build` does NOT type-check (`typescript.ignoreBuildErrors` in
`apps/web/next.config.ts`): `make typecheck` is the type gate, and checking
twice cost ~7s on every smoke run and Docker build. So a green smoke alone does
not mean the types are clean — run both.

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

## Production

One Docker host, documented in `docs/deploy.md`: `docker-compose.prod.yml`
plus `scripts/deploy.sh` (`deploy`/`rollback`/`status`), `scripts/backup.sh`,
`scripts/restore.sh`, and the systemd templates in `ops/systemd/`.
`make test-ops` runs the migration-guard unit test, the deploy self-exec
test, a real reproduction of collation corruption and its repair, and a
backup/restore round trip (about 30s). `make lint` shellchecks every script.

## Architecture rules (a reviewer should reject violations)

1. **The API is tRPC in `packages/api`.** Add a procedure there, not a Next route
   handler. Route handlers exist only for things tRPC cannot carry: auth
   (`/api/auth/[...all]`), file bytes (`/api/media/*`), health (`/api/health`),
   and machine callers authenticated by a secret instead of a session: cron
   triggers (`/api/cron/[schedule]`, `requireCronAuth`), inbound webhooks
   (`/api/webhooks/*`, signature over the raw body: `email-events` (Resend
   via `verifySvix`, or generic `verifyHmac`), `email-inbound` (`verifyHmac`),
   `twilio` and `twilio/status` (`verifyTwilioWebhook` from `@repo/sms`)) and
   the MCP endpoint (`/api/mcp`, an org API key; its tools call tRPC
   procedures), and the glance page (`/glance/<gl_…>`, a read-only glance
   link: HTML for Meta Ray-Ban Display glasses, where nobody can sign in;
   `packages/api/src/glance.ts`). Copy those. A webhook verifies, stores,
   and hands slow work to a job; it never does that work in the request.
2. **Tenant isolation lives in `orgProcedure`, not in resolvers.** Any query on
   an org-scoped table goes through `orgProcedure` and filters on
   `ctx.organizationId`. Mutations use `updateMany`/`deleteMany` with the org in
   the `where`, never `update`-by-id plus a separate ownership check.
3. **`env()` from `@repo/env`, never `process.env`.** It validates once and fails
   with a readable message. Node entrypoints start with `import "@repo/env/load"`.
4. **The model is config.** Models are `provider/model` strings in .env
   (`anthropic/…`, `openai/…`, `azure/<deployment>`, `openrouter/…`, `local/…`,
   `cli/…`), picked by tier: app code calls `ask({ tier: "fast", priority, … })`,
   never a model id. Every call declares `priority: "essential" | "discretionary"`
   — the per-tenant daily cap (`LLM_DAILY_CAP_USD`, per UTC day; unset or blank = $2, `off` disables)
   refuses discretionary calls BEFORE sending (over the cap, or on a model with
   no known price) and never refuses essential ones. Each call first RESERVES
   its estimate as a `pending` `llm_call` row under a per-tenant advisory lock,
   so concurrent calls cannot all slip under the cap; the row is then settled
   with the real cost. A row left pending by a dead process is marked
   `abandoned` after ~15 min (`staleAfterMs`) and keeps counting its estimate. Claude goes through the official `@anthropic-ai/sdk`, never an
   OpenAI-compatible shim. Structured output is `askObject`: zod-validated, never
   repaired — a failure is `{ ok: false, reason }` for a human to handle.
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
   `packages/outbound`). Channels: `email` (`sendMail` from `@repo/email`),
   `sms` (`sendSms` from `@repo/sms`) and `push` (ntfy, only via
   `notifyOperator` from `@repo/notify`). Each provider is reachable from ONE
   file, its channel's transport: mail SDKs (nodemailer, resend) and
   `RESEND_API_KEY` only in `packages/email/src/transport.ts`, the Twilio API
   host and `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` only in
   `packages/sms/src/transport.ts` (a ~150-line fetch client; the `twilio` SDK,
   ~11 MB in the bundle for three calls, is refused everywhere), `NTFY_URL`/`NTFY_TOKEN` only in
   `packages/notify/src/ntfy.ts` (ESLint rules in `eslint.boundaries.mjs` fail
   `make lint`; wiring tests back them up). A new channel gets its own package
   that calls `deliver` and does not export its raw transport, plus a
   `Channel` value, a recipient parser and an enable flag in the same change.
   Transports refuse the real SDK under `NODE_ENV=test`; tests install a fake
   (`useFakeResend`, `useFakeTwilio`).
9. **Mutations write an audit event in the same transaction**:
   `ctx.db.$transaction(async (tx) => { ...; await ctx.audit("item.delete", { targetId }, tx) })`.
   `packages/api/src/routers/items.ts` is the reference.
10. **Expected failures throw typed errors** from `packages/api/src/errors.ts`
    (`NotFoundError`, `DomainRuleError`, `ConflictError`, `ForbiddenError`);
    the API maps them to NOT_FOUND / BAD_REQUEST / CONFLICT / FORBIDDEN with
    their message, which the user sees. Anything else is a 500 whose message
    and stack are hidden in production. Plain route handlers get the tenant
    from `requireTenant(req)` (`apps/web/src/lib/route-auth.ts`), which shares
    `orgProcedure`'s resolution — including the check that the user is STILL
    a member of the session's active org (better-auth does not clear it when
    an admin removes someone).
11. **File access is scoped to the ACTIVE org**, like every other read: the
    `/api/media` routes serve only the active tenant's files, never "any org
    the user belongs to". Deliberate; a user in two orgs switches org to see
    the other's files.

## Outbound messages and safe mode

Exists because a production app emailed the wrong thing to 8 real customers.
`deliver()` runs these gates in order; the first that fails blocks the message:

0. recipient: exactly ONE plain address. Lists (`a@x, b@y`), display names
   (`Name <a@x>`) and anything else a mail library would expand are blocked as
   `INVALID_RECIPIENT`; the parsed address is what gets checked, capped,
   logged, and handed to the transport. SMS: one number in international
   form, normalised to E.164 (`+44 7700 900123` → `+447700900123`); a
   national number (`07700 900123`) is refused, never guessed at. Mobile
   push: one Expo push token (`ExponentPushToken[...]`), case kept.
1. channel switch `OUTBOUND_EMAIL_ENABLED` (on), `OUTBOUND_PUSH_ENABLED` (on),
   `OUTBOUND_SMS_ENABLED` (OFF), `OUTBOUND_MOBILE_PUSH_ENABLED` (OFF)
2. kill switch: `OUTBOUND_FROZEN=true`, or at runtime with no restart:
   `npm run outbound:freeze -- on` / `off` / `status` (stored in `app_setting`)
3. **safe mode**, resolved once per process and printed loudly at boot:
   - `strict`: only `OUTBOUND_SAFE_RECIPIENTS` (addresses, `@domain`, exact
     E.164 numbers) get anything; everything else is blocked and logged.
   - `local-catcher`: everyone is allowed. Only via an explicit
     `OUTBOUND_SAFE_MODE=local`, which asserts SMTP is a catcher (Mailpit) that
     delivers nowhere. `.env.example` sets it, so `make dev` just works. It is
     never inferred from a loopback `SMTP_HOST` (a local postfix relays to the
     internet), and production refuses it and runs strict. It opens EMAIL
     only: SMS, push and mobile push have no catcher (they reach real
     phones), so for them it means strict.
   - `off`: real mail to real people (`OUTBOUND_SAFE_MODE=false`, or unset in
     production).

   Unset outside production = `strict`, so a staging box loaded with
   production data cannot mail a customer.

4. suppression list (`outbound_suppression`: global for hard bounces and
   complaints, fed by `/api/webhooks/email-events`, and for SMS STOP, fed by
   `/api/webhooks/twilio` in the request itself (an opt-out must not wait for
   the worker), lifted again by START; per-org for unsubscribes). One STOP
   suppresses that number for EVERY tenant, deliberately: it mirrors the
   carrier's own block on the shared sender number.
5. volume caps in Redis: per recipient/hour, per org/hour and /day, and a
   global/hour, with SEPARATE global pools for auth mail and app mail so a
   flood of anonymous sign-ups cannot starve tenants' mail. Redis unreachable =
   **blocked** (fails closed).

Every attempt writes one `outbound_message` row, BEFORE the provider is
called, so nothing leaves without a record. Blocked sends resolve with
`status: "blocked"` (they do not throw); provider errors throw after being
recorded as `failed`. If the provider accepted a message but recording "sent"
fails, it still returns sent (the row stays `pending`) so a retry cannot send
it twice. Tenants read their own rows via `activity.outbound`.

**Retries and idempotency.** Pass `idempotencyKey` (`invoice.42.reminder`)
from anything that retries. Keys are per tenant (system rows share one
namespace). A second `deliver` with the same key reuses the first row: once
sent, it is returned untouched; while another attempt holds it (`pending`,
claimed under 5 minutes ago) it returns `status: "in_progress"` and sends
nothing; otherwise (failed, blocked, or a stale pending) it takes the row with
a compare-and-set, so of any number of racing retries exactly one sends. The
same key for a different channel or recipient throws `ConflictError`
(CONFLICT) and sends nothing. An attempt's final write ("sent"/"failed") only
applies while it still holds its claim, so a sender slow enough to be taken
over cannot overwrite the retry's outcome. If the provider accepted a message
but marking it sent failed, the row stays `pending`, and a keyed retry
re-sends it once the 5-minute window has passed (SMTP and Twilio cannot tell
us they already have it; Resend drops the repeat by its key). A send reuses
the row id, which the transport hands the provider (Resend's
`Idempotency-Key`; every email's `Message-ID` is `<obm.<row id>@<from
domain>>`, which is how replies are threaded). SMTP and Twilio take no key, so
a crash between their accepting a message and our marking it sent can still
duplicate one.

**Delivery status.** `status` is the guard's verdict ("the provider took
it"). What happened next is `deliveryStatus` (`delivered`, `bounced`,
`undelivered`, `complained`, ...), written by the Resend and Twilio webhooks by
provider message id and never moved backwards (`recordDeliveryStatus`). The
`sms.reconcile` job asks Twilio about texts with no final status after 15
minutes, because a lost callback otherwise makes a dead number look
delivered (it did, for months, in the app this came from).

**Operator messages vs safe mode.** `notifyOperator` sends with
`operator: true`, which is exempt from the strict allowlist ONLY when the
recipient is exactly the configured `NTFY_TOPIC` / `OPERATOR_EMAIL` (the guard
checks it, not the caller). Kill switch and suppression still apply; the
verified operator skips the per-recipient cap (an urgent alert must not stop at
the 11th of the hour) and counts in its own `operator` global pool.
`sendOperatorMail` takes no `to`: it can only mail `OPERATOR_EMAIL`. They are recorded with `organizationId` null,
so no tenant sees them (or the topic). `local` safe mode opens email only: a
push reaches a real phone, so push stays strict. A staging box with
production's `NTFY_TOPIC` alerts production's operator: every title is
prefixed with the `APP_URL` host (`[staging.example.com] …`) so the two can be
told apart, but give staging its own topic.

**Mobile push vs safe mode.** The recipient the guard checks, caps and logs
is the device's Expo push token (one `deliver` per device; the transport
batches them into one Expo request). Strict mode lets a device through if
`OUTBOUND_SAFE_RECIPIENTS` lists its exact token, OR its owner's verified
email or `@domain`: the guard looks the owner up itself (`push_device` →
`user`, `emailVerified` only), so `you@yourco.com` in the list is "my own
phone" without copying a token that changes on reinstall, and no caller can
claim an owner. Pushes carry NO customer data (lock screen, and Expo's and
Apple's/Google's servers in between): "New email", never who or what; `data`
holds ids only. Same default as the desktop shell.

**Auth mail vs safe mode.** better-auth's verification mail is sent with
`sendAuthMail`, which is exempt from the strict allowlist and nothing else.
The recipient just typed that address into the sign-up form, so it cannot be
"the wrong person", and without the exemption nobody could sign up on a
strict box. The kill switch, suppression and caps still apply. Use
`sendAuthMail` for better-auth callbacks only. `make smoke` forces safe mode
to `strict` with an empty allowlist, so the gate proves sign-up still works.

## Inbound messages (packages/inbound)

Email and texts that ARRIVE land in `inbound_message` (org-scoped), shown on
`/app/inbox` (tRPC `inbox.*`).

- **Routing** is an explicit table, `inbound_route` (channel, address →
  tenant), nothing guessed from content. Email: each tenant gets one random
  address on `INBOUND_EMAIL_DOMAIN` (`acme-k3x9p2mq@in.example.com`, created
  from the Inbox page; at most one per tenant, `inbound_route.autoForOrg`);
  `+tag` addresses route like the bare one; add rows for any other address.
  SMS: the number texted if it has a row. **One Twilio number per tenant (an
  `inbound_route` row) is the safe multi-tenant setup.** On a shared number a
  reply goes to the tenant that texted the sender in the last 30 days ONLY if
  exactly one did; if two did, it is about either (and "text a rival's
  customer to capture their replies" must not work), so it is not routed, and
  the operator is told (low, deduped). No match = not stored (logged, 200 to
  the provider).
- **Flow**: the webhook verifies, stores a `received` row (unique on provider +
  provider id, so retries are duplicates) and queues `inbound.process`. The
  job fetches Resend's content (its webhook carries only metadata), stores
  attachments in packages/storage at deterministic keys (only the upload
  allow-list's types; the rest are listed as skipped), threads to the
  outbound message it answers (same tenant only) and marks it `processed`.
  If queueing failed, the 15-minute `operator.digest` tick re-queues it.
- **HTML is never rendered.** It is stored as received; the UI shows text
  (derived from the HTML when a mail had none), so a stranger's HTML never
  runs on our origin.
- **Providers**: Resend (`email.received` on `/api/webhooks/email-events`),
  any other sender via the generic signed `/api/webhooks/email-inbound`
  (body format: `genericInboundEmail` in `packages/inbound/src/process.ts`),
  Twilio on `/api/webhooks/twilio`. Twilio signs the PUBLIC URL it called:
  verification rebuilds it from `TWILIO_WEBHOOK_BASE_URL` (else `APP_URL`)
  plus the path, never from the request (behind a proxy that is an internal
  host). A wrong base URL shows as `[sms] refused a webhook ...` in the log.
- No auto-replies to texts: Twilio's Advanced Opt-Out answers STOP/HELP.
- Every webhook caps its body while streaming (`readBodyLimited`) BEFORE any
  signature work, then verifies the signature. Only requests whose signature
  FAILED are rate-limited per IP (`refuseUnsigned`, fails open): the IP is
  X-Forwarded-For, which an attacker can set to Twilio's, so throttling all
  traffic would let anyone 429 real callbacks (a lost STOP is not retried).
- Twilio signatures carry no timestamp, so a captured, validly signed START
  could be replayed to lift a STOP. Accepted: it needs a request Twilio
  signed for that number, and the carrier keeps its own block regardless.

## Operator notifications

`notifyOperator({ title, body, priority, dedupeKey?, url?, tags?, organizationId? })`
from `@repo/notify` tells whoever RUNS the app (not tenants) about something:
wired today for a job that failed for good (worker, high, one per job name per
window), a tenant hitting the daily AI cap (packages/ai, once per org per UTC
day) and new sign-ups (low, digest only). It never throws.

- Every call writes a `notification` row; the send is also an
  `outbound_message` row. Same `dedupeKey` within
  `NOTIFY_DEDUPE_WINDOW_MINUTES` (or the call's `dedupeWindowMinutes`) =
  `deduped`, but only when the earlier one reached the operator (sent, logged,
  held, digested, or in flight for under 2 minutes): a failed alert never
  silences its repeat.
- Channel: ntfy push if `NTFY_TOPIC`, else email to `OPERATOR_EMAIL`, else
  the console. Titles go out prefixed with the `APP_URL` host. **No customer
  data in titles or bodies**: on ntfy.sh the topic is the only password. Ids,
  counts, error classes.
- `low` waits for the digest at `NOTIFY_DIGEST_TIMES` (APP_TIMEZONE); the
  rest is sent at once (`normal`/`high`/`urgent` only change ntfy's loudness).
  The `operator.digest` job runs every 15 minutes: it retries high/urgent
  alerts the volume cap held, then sends the digest if one is due. A digest
  that is not delivered is marked failed and gives its items back to the next
  slot. No quiet hours or daily budget (cut: not worth it at this volume).
- No UI: there is no app-wide operator role, and tenant admins must not see
  them. Read the table directly.
- `make smoke` forces the console channel and checks sign-up logged one.

## Agents, proposals and MCP

**An agent run** (`packages/agent`) is a bounded tool-use loop over
`converse()` in `packages/ai`: Anthropic's native tool use through the official
SDK for `anthropic/`, the AI SDK's tool calling for the OpenAI family; `cli/`
cannot call tools and fails with a clear error. `agent.start` (tRPC) writes an
`agent_run` row and enqueues the org job `agent.run`; the WORKER runs it, so a
request never waits on a model. Bounds: `AGENT_MAX_STEPS` turns,
`AGENT_MAX_COST_USD` per run, and the tenant's daily cap (calls are
`discretionary`), and each model turn is aborted after 120s
(`TURN_TIMEOUT_MS`). Cancel is checked before every turn and aborts the call
in flight. At pickup the worker checks the run's starter is still a member;
if not, the run fails without calling the model. A run still "running" past
`runCutoffMs()` (max steps × turn timeout + 5 min) has no live worker: the
15-minute operator tick marks it failed, Cancel ends it at once, and a late
finish never overwrites either (the final save requires status "running").
Every step lands in `agent_step` (the trace). Only an unexpected
failure notifies the operator (low priority, once per tenant per day); "AI is
off" or "over the cap" is the run's recorded outcome, not an alert.

**Write tools never act inside a run.** A call becomes an `agent_proposal`
(pending). A member approves (optionally editing the input, re-validated
against the tool's zod schema) or rejects it at `/app/agent`. Approve claims
the row with `updateMany ... status: "pending"` and runs the tool's `apply`
with the reviewer as actor, in ONE transaction with the audit events, so a
proposal is decided once and never says "applied" for a change that rolled
back. If `apply` throws (the item is gone), the proposal becomes `failed`
with the message.

**Domain functions, called by both tRPC and agent tools.** A write that a
person can make in the app AND an agent can propose is defined once, in
`packages/domain` (`items.ts` is the reference): the zod input schemas with
their field limits, and `createItem(tx, actor, input, audit)`-style functions
that take the transaction, the actor from the caller's context and an audit
function bound to that transaction, write with `updateMany`/`deleteMany` and
the org in the `where`, and throw `NotFoundError`. The tRPC router and the
agent tool are then thin wrappers. `packages/api` and `packages/agent` never
import each other; both import `packages/domain`.

**Add a tool:** `defineReadTool` / `defineWriteTool` in
`packages/agent/src/tools/` (`items.ts` is the reference), list it in
`registry.ts`. Name it `[a-zA-Z0-9_-]` (no dots: both providers reject them).
Take the tenant from the context, never from the input. A read tool gets a
READ-ONLY transaction (`SET TRANSACTION READ ONLY`): if it writes, Postgres
refuses. A write tool's `summarize` builds the queue's one-line summary from
the DATABASE (the real title of what would be deleted), never from the
model's text; the model's own words (a "reason") go in `claim` and are shown
as unverified. `apply` calls the domain function with `ctx.tx`; it is for
database writes, so for a side effect outside the database, enqueue a job
from it. The unit test in `loop.test.ts` checks names and schemas of every
registered tool.

**MCP** is streamable HTTP at `/api/mcp`, stateless (a server per request,
JSON responses), authenticated by a per-org API key (`Authorization: Bearer
tk_...`; only its SHA-256 is stored; created and revoked by owners/admins via
`apiKeys.*`, audited). Key semantics:

- A key acts as the member who made it, in the key's org only: if they leave,
  the key stops working (orgProcedure refuses an API key whose org it would
  otherwise fall back from). Revoked = refused, the same 401 as unknown.
- "Can write" holds only while that member is STILL an owner/admin, checked
  on every request; a demoted admin's write key becomes proposals-only.
- Without write access: read tools work, write tools queue proposals
  (recorded with `proposedById` and `apiKeyId`), and `agent_start` is
  refused, since a run spends the workspace's AI budget.
- POST only: GET and DELETE are 405 (stateless: no stream, no session).

Each MCP tool calls the SAME tRPC procedure as the web app through a
server-side caller (`packages/api/src/mcp.ts`): no business logic of its own.
Read tools answer directly; write tools call `agent.propose` unless the key
has write access. Rate limited per key (`MCP_RATE_LIMIT_PER_MINUTE`) and per IP on
failed auth. Connect Claude Code:
`claude mcp add --transport http app <APP_URL>/api/mcp --header "Authorization: Bearer tk_..."`.

## Documents and search (packages/rag)

Org-scoped `document` + `document_chunk` tables; `/app/docs` in the UI; the
`docs` tRPC router; `docs_search` as an agent read tool and an MCP tool.

- **Ingest** is the `docs.ingest` job (org scope), enqueued after the create
  commits. Text arrives as a string (`docs.create`, ≤ 500,000 chars; the
  browser reads the .md/.txt file) or from a text file already in storage
  (`docs.fromMedia`: text/plain, text/markdown, text/csv; the worker reads the
  bytes). Chunker (`src/chunk.ts`): markdown headings split sections, every
  chunk carries its heading path with the doc title as root
  ("Guide › Setup › Ports"), paragraphs are packed to 1200 chars with 150
  overlap. The heading path is embedded with the chunk and indexed at FTS
  weight A.
- **Idempotent.** `document.contentHash` = sha256(chunker version, title,
  text). Same hash as the last index + all chunks embedded = no-op. Otherwise
  the chunks are replaced in one transaction; a chunk whose own hash did not
  change keeps its embedding (never across embedding models). Changing the
  chunker? Bump `CHUNKER_VERSION` so everything re-indexes.
- **Embeddings are best-effort.** AI off, over the cap, provider down: chunks
  are stored without vectors, the document is `ready` and its `note` says
  "keyword-only" and why. A later re-index (or ingest with embeddings on)
  fills them in. Bad input (not UTF-8, a stored file over 500,000 chars)
  marks the document `failed` and is returned, not thrown (no retries, no
  operator page).
- **A document never stays "indexing".** Could not queue (Redis down; the
  enqueue gives up after 5s) → `failed`; the job failed for good →
  `failed` (the registry's `onFinalFailure` hook); lost job (worker killed) →
  the 15-minute operator tick fails rows in flight for over an hour. Each
  note says "Re-index to retry". The UI polls with backoff and stops after
  3 minutes (Refresh resumes). Two ingests of one document serialise on an
  advisory lock, and a run that read the text before an edit writes nothing
  (`superseded`).
- **Search** (`searchDocs`): keyword leg (`to_tsquery` of the query's words
  OR-ed, ranked by `ts_rank_cd` + 1 for chunks matching the whole query via
  `websearch_to_tsquery`) and meaning leg (cosine kNN, HNSW with
  `hnsw.iterative_scan = relaxed_order`, needed because the org filter would
  otherwise starve plain HNSW), fused with Reciprocal Rank Fusion, k = 60.
  Snippets are `ts_headline` with private-use markers, returned as
  `snippetParts` for highlighting. The query is embedded BEFORE the
  transaction opens. With embeddings unavailable the result is
  `mode: "keyword"` with `keywordOnly: <reason>` — CI and smoke run this way.
- **Answer** (`docs.answer`): askObject over the top 6 chunks; the model
  must cite `[n]` with a verbatim quote. Out-of-range citation, a quote not in
  its source, `known: false`, or a number/email/link absent from the sources
  (`assertGrounded`) → `status: "unknown"` with the sources, for a person.
  No sources → "unknown" without calling the model. To avoid false
  rejects: list numbering and `[n]` markers are not checked as facts,
  "02:00" equals "2:00", quotes are matched against link TEXT
  (`[text](url)` → text), and an elided quote ("a … b") must have its pieces
  in order.
- **Raw SQL lives only in `packages/rag/src/store.ts`.** Prisma cannot read
  `vector`/`tsvector` columns. Tagged templates only (bind parameters),
  `organizationId` in every WHERE and join. Unqualified table names work in
  tests because `packages/db` pins the connection's `search_path` to the
  `?schema=` schema, then `public` (where pgvector lives). It is set as a
  connection startup option (`-c search_path=...`), which PgBouncer in
  transaction mode and some managed Postgres poolers reject or drop. Behind
  one, use `?schema=public` (nothing is set then) or set the role's
  search_path server-side (`ALTER ROLE ... SET search_path`).
- **Embedding size is fixed by the column**: `vector(1536)`, and
  `EMBEDDING_DIMENSIONS` in `src/store.ts`. Not a setting: it cannot differ
  from the column. Every embed() asks for that size (text-embedding-3-*
  shortens natively) and refuses any other length; a wrong-size vector
  degrades ingest and search to keyword-only, never a SQL error. A different
  size = a migration altering the column and rebuilding the HNSW index, the
  constant, and a re-index of every document.
- **The agent's `docs_search` embeds the query inside its read-only
  transaction** (a read tool has no pre-transaction step). ~100–300 ms of an
  open transaction per call; see the comment in
  `packages/agent/src/tools/docs.ts` for the fix if that ever matters.
- **Prisma and the hand-written SQL.** The `tsv` generated column and the
  HNSW index are hand-edited in migration `rag_documents`. The schema mirrors
  them (`@default(dbgenerated(...))` with the exact expression Postgres
  reports, `@@index([embedding], map: ...)`) so `migrate dev` sees no drift.
  If you change either, check `npx prisma migrate diff
--from-config-datasource --to-schema prisma/schema.prisma --script` prints an
  empty migration.

## Evals (packages/evals)

Lives in a workspace package so turbo runs its tests in `make test`, it gets
typecheck/lint like everything else, and it imports rag/ai as TypeScript
source.

```bash
npm run eval                                           # offline: ~1s, free, deterministic
npm run eval -- --live --model anthropic/claude-opus-5-5   # real providers, keys from .env
npm run eval -- --live --judge                         # + LLM-as-judge graders
npm run eval -- --suite retrieval --failures           # one suite, failing rows only
npm run eval -- --save-baseline                        # accept this run's scores
```

Each run makes a throwaway migrated schema (like the int tests), ingests
`fixtures/corpus/*.md` into a fresh tenant, prints a table (score, cost,
latency per case), writes the full JSON to `packages/evals/reports/`
(gitignored) and compares with `baselines/<offline | live-<model>>.json`:
exit 1 if a suite drops more than `--threshold` (offline 0 — plus any case
that passed in the baseline and fails now; live 0.05). Offline = retrieval
FTS-only, and the answer model replaced by a replay of each case's `offline`
output, so the code AROUND the model (retrieval, citation and grounding
checks, routing to "unknown") is what is tested. `test/offline.int.test.ts`
runs exactly that inside `make test` as the regression gate.

**Adding a golden case** — one JSON object per line:

- Retrieval (`golden/retrieval.jsonl`):
  `{"id":"r-x","input":"the query","expected":["backups"],"tags":["keyword"]}`
  — `expected` names corpus files (without `.md`), any of which counts as
  relevant; scored by reciprocal rank in the top 5 (suite score = MRR).
  Add the text it should find to `fixtures/corpus/` if it is not there.
- Answer (`golden/answer.jsonl`): `input` is the question, `graders` a list of
  `exact` / `contains` / `regex` (each with an optional dot `path` into the
  result: `status`, `reason`, `answer`, `citations`), `schema` (a JSON Schema)
  and `judge` (a `rubric`; runs only with `--judge`). `offline` is the canned
  model output `{"known", "answer", "quotes": [...]}`; `"offlineOnly": true`
  marks guard tests (a fabricated number, a fake quote) that a live model
  will not reproduce.

Then `npm run eval`; if the new numbers are right, `--save-baseline` and
commit the baseline with the case. Live baselines are per model; save one
with the first live run of a model.

## UI (apps/web)

**Use the kit; do not hand-roll.** Every button, input, modal, menu, table and
toast comes from `apps/web/src/components/ui/` — shadcn/ui (new-york style,
neutral base colour, CSS variables), copied into the repo so you own the code.
See every component rendered at **`/design`** (public, static, noindex; source
in `src/app/design/styleguide.tsx` doubles as usage examples).

- **Where things live.** `components/ui/*` = the kit (shadcn files plus our
  `data-table`, `states` (loading/empty/error/`FieldError`), `file-drop`,
  `confirm-dialog`). `components/app-shell.tsx` = the signed-in sidebar +
  header (add nav entries to `NAV`). `lib/utils.ts` = `cn()`. Theme tokens =
  `:root` / `.dark` in `src/app/globals.css` — re-skin there, not per component.
- **Add a shadcn component:** `cd apps/web && npx shadcn@4.23.0 add <name>`
  (reads `components.json`). Recent registries import `cn` from a separate
  `cn` npm package (pre-1.0); this repo keeps `cn` in `@/lib/utils`
  (clsx + tailwind-merge, like the production apps), so point the import back:
  `sed -i 's#from "cn"#from "@/lib/utils"#' src/components/ui/<name>.tsx` and
  `npm uninstall -w web cn` if the CLI added it. Then pin any new dependency
  exactly in `apps/web/package.json`, run `npx prettier --write src` and
  `make lint` (the React Compiler lint rules flag a few upstream files — fix
  them, see `hooks/use-mobile.ts`), and add the component to `/design`.
- **Dark mode** is next-themes, class-based (`dark:` follows the user's choice).
  The root layout must keep `<html suppressHydrationWarning>`; that is what lets
  the inline script set the class before first paint (no flash). `ThemeToggle`
  is a plain button on purpose.
- **Forms:** react-hook-form + the kit's `Form*` components. In client code
  validate with named imports from `zod/mini` (see `login-form.tsx`): classic
  `zod` adds ~60 kB gzipped to the page. Server code keeps classic zod. Keep
  labels visible (`FormLabel`).
- **Prisma enums in client code:** `import { X } from "@repo/db/enums"` —
  plain objects, no Prisma client in the bundle (verified against a real
  build). Never import `@repo/db` from a `"use client"` file.
- **Every query-backed panel** renders exactly one of `LoadingState` /
  `ErrorState` / `EmptyState` / data. Mutations report with `toast` (sonner).
- **Formatting:** never `toLocaleString` ad hoc. `useFormat()` (client, from
  `components/format-provider.tsx`) or `getFormatter()` (server,
  `lib/format-server.ts`) — locale, currency, timezone come from `APP_LOCALE`,
  `APP_CURRENCY`, `APP_TIMEZONE`. Money is integer minor units (cents).
  `useFormat()` only sees the env config under `/app` (its layout provides it);
  elsewhere it falls back to en-US · USD · UTC.
- **Auth guard, two layers:** `src/app/app/layout.tsx` redirects without a
  session, AND every `/app` page (and any server-side data access) calls
  `requireSession()` from `lib/session.ts`. The layout alone is not enough:
  Next renders layouts and pages in parallel and can skip a layout on client
  navigation. The lookup is `cache()`d per request, so repeating it is free.
- **The root layout reads nothing per request** (no `env()`, no cookies) so
  static pages like `/design` prerender and the Docker build needs no secrets.
  It also mounts no `<Toaster>`: the `/app` layout and `/design` do, so sonner
  stays off the public pages. A new page tree that toasts mounts its own.
- **Deleting `/design`?** Delete `e2e/design.spec.ts` with it; nothing else in
  the gate depends on it.
- **Bundle:** watch first-load JS when adding client libraries; Radix menus,
  popovers and tooltips pull in positioning code — keep them off public pages
  that do not need them.
- **`/glance/<gl_…>` is the one page that is NOT the kit**, on purpose: Meta
  Ray-Ban Display glasses load it over a slow link (Meta's budget: 300 KB),
  draw black as transparent, and navigate with a D-pad. It is one hand-written
  HTML string (`src/lib/glance-html.ts`, ~5 KB, a nonce'd inline script, no
  Next bundle) served by a route handler. Members create/revoke their own
  glance links at `/app/glasses` (`glance.*` procedures; a link reads only
  `glanceSnapshot` for its org, is stored hashed, dies with membership,
  expires (30 days by default) and shows counts only unless `showDetails`).

## Mobile (apps/mobile)

Same API as the web app (tRPC with the session cookie attached by hand; file
bytes to `/api/media/*`). Screens: `items` (with dictation), `photos`,
`device` (push status, test push), `glasses` (capture flow), `proposal/[id]` and `inbox/[id]`
(what tapping a push opens: `lib/push-route.ts` maps its `kind`/`id`).
Sign-out unregisters the push token and clears expo-image's caches. New screens use
`components/states.tsx` (Loading / Empty / Error / Button / ProgressBar).

**Expo Go or a development build.** Expo Go runs sign-in, items, photos
(camera, library, upload) and dictation. Push notifications and the glasses
module need a development build: Expo Go cannot receive a project's remote
pushes (removed on Android in SDK 53) and holds no custom native code.

```bash
cd apps/mobile
npx eas init                                   # once: prints EAS_PROJECT_ID → .env
npx eas build --profile development --platform android   # dev client APK
npx eas build --profile development-simulator --platform ios
npx eas build --profile preview                # internal test build
npx eas build --profile production             # store build (build number auto-incremented)
cd ../.. && make mobile-dev-client             # dev server for the dev client
```

`make mobile` starts Expo with `--go`: with expo-dev-client installed, a bare
`expo start` would target the dev client and Expo Go users would get a QR
code their app cannot open. `make mobile-dev-client` is the other one.

`eas.json` profiles: `development` (dev client, internal distribution, APK /
device build), `development-simulator`, `preview` (internal), `production`.
Cloud builds have no `.env`: set `MOBILE_*`, `APP_SCHEME`, `EAS_PROJECT_ID`
and `EXPO_PUBLIC_API_URL` as EAS environment variables per environment.

- **Uploads** (`lib/upload.ts`): expo-file-system's native upload task
  (streams from disk, reports progress, sends the cookie). Never
  `FormData.append("file", { uri, name, type })`: see "Things that will bite".
- **Push** (`lib/push.ts`, `lib/use-push.ts`): on sign-in the app gets its
  Expo token and calls `push.register` (repeat = heartbeat); sign-out calls
  `push.unregister` first. Sent by `@repo/push-mobile` through the guard;
  the worker's `push.receipts` (every 15 min) records Expo receipts and
  disables devices reported `DeviceNotRegistered`. Wired: a pending proposal
  (to the user it was made for) and a new inbound message (to the org's
  members with a device), via the `push.notify` job, one per event, idempotent
  per device. Nothing is queued while `OUTBOUND_MOBILE_PUSH_ENABLED` is off.
  Receipts are asked for 15 minutes to 24 hours after sending, oldest first,
  a page at a time; one still missing after 24 hours (Expo has dropped it)
  is marked `unconfirmed`. The activity log masks tokens (`maskRecipient`):
  a token lets its holder push to that phone or take the device over. In
  production enable Expo's "enhanced push security" (`EXPO_ACCESS_TOKEN`).
- **Dictation**: expo-audio records 16 kHz mono AAC; `POST
/api/media/transcribe` runs `transcribe()` from `@repo/ai`
  (`LLM_TRANSCRIBE_MODEL`, `openai/` or `local/` OpenAI-compatible
  `/audio/transcriptions`) into `llm_call` under the daily cap: reserved
  per minute (`LLM_TRANSCRIBE_COST_PER_MINUTE` x the longest the file can be
  for its format), settled per token when the server reports tokens and
  `LLM_PRICES` has the model, else per reported minute. The audio is not
  stored. The button hides when it is not set up.
- **Glasses** (Meta Ray-Ban / Oakley / Display; full story in
  `modules/glasses/README.md`): a local Expo module wrapping Meta's Wearables
  Device Access Toolkit 1.0 (Android from Maven Central, iOS a Swift Package
  via `spm_dependency`). **Opt-in at build time**: with `GLASSES_ENABLED`
  unset its config plugin EXCLUDES the module from autolinking (Podfile
  `use_expo_modules!(exclude:)`, settings.gradle `expoAutolinking.exclude`),
  so default builds are byte-for-byte what they were; on, it adds the
  Info.plist/manifest entries and raises minSdk 29 / iOS 17.2. The JS API
  reports `unavailable` instead of throwing at import, everywhere.
  `app/glasses.tsx` runs capture → `uploadMedia` → `ai.describeImage`
  (optional, discretionary, `tier: "fast"` must be a vision model; `ask()`
  takes `images`, cli/ refuses them) → `expo-speech` (plays through the
  glasses over Bluetooth). Sources: real glasses, Meta's MockDeviceKit
  (phone camera as the glasses' camera), or the phone camera (Expo Go).
  Android is compiled against the real SDK and the simulated-glasses flow was
  run end to end on an emulator; **iOS is unverified** (no Xcode here), so an
  iOS build with the flag is refused unless `GLASSES_IOS_EXPERIMENTAL=1`. The
  flag-on Android build forces one Fresco version (the DAT pulls fbcore 3.7,
  React Native 3.6: launch crash otherwise). MockDeviceKit only in eas.json's
  development profiles. Display glasses get the web page `/glance/<gl_…>` (see UI above).

## Things that will bite you (all learned here, the hard way)

- **A database image with another C library silently corrupts text
  indexes.** Existing volumes sort text with the image's libc; reopened under
  a different one (Alpine/musl ↔ Debian/glibc), lookups miss rows and unique
  indexes admit duplicates — after which the fixing REINDEX itself fails.
  `scripts/lib/collation.sh` + `packages/db/prisma/ops/collation-guard.sql`
  detect it (stored vs actual collation version) and rebuild. They run from
  `deploy.sh` (app stopped first when the db image changes, and on every
  deploy and rollback), from the `migrate` image before every migration,
  from `make up` and `setup.sh`. New volumes use the builtin `C.UTF-8`
  collation (`POSTGRES_INITDB_ARGS`), immune to libc. `deploy.sh` re-execs
  itself after pulling so a release is always deployed by its own script.
  The db image is now `pgvector/pgvector` (Debian, glibc) instead of
  `postgres:17-alpine` (musl) — exactly this change for every existing
  volume. Details and the by-hand fallback: `docs/deploy.md`.
- **Blank `*_URL=` lines are deleted from `process.env`** by `@repo/env`
  when it loads. `@ai-sdk/openai` builds a default provider from
  `OPENAI_BASE_URL` at import and crashes the server on a blank value (a
  copied `.env.example`). Import `@repo/env` before any SDK that reads the
  environment itself.
- **Extensions live in `public`, tests run in `vt_*` schemas.** The test
  harness installs every `CREATE EXTENSION IF NOT EXISTS x` it finds in a
  migration into `public` first; otherwise it would land in the throwaway
  schema and its `DROP ... CASCADE` would take the vector columns of a
  concurrent run with it. Write extension migrations as
  `CREATE EXTENSION IF NOT EXISTS name` so the harness sees them.
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
- **Expo's global `fetch` rejects React Native's file parts.** Since SDK 52
  `fetch` is expo/fetch, whose FormData encoder takes a string, a Blob or an
  object with `bytes()`. `body.append("file", { uri, name, type })` (every
  RN upload example) throws "Unsupported FormDataPart implementation" and
  nothing is uploaded. Use `uploadMedia` / `transcribeAudio` from
  `apps/mobile/lib/upload.ts`; `lib/upload-body.test.ts` runs both shapes
  through expo's real encoder.
- **React Native's `<Image>` drops `source.headers` on Android** (new
  architecture; seen on an emulator: the request arrived with no Cookie and
  every photo was a 401). Show authenticated media (`/api/media/blob`, the
  local storage driver) with `expo-image` and `mediaSource()` from
  `apps/mobile/lib/media.ts`, as `app/photos.tsx` does.
- **Push needs a development build, a physical device and `EAS_PROJECT_ID`.**
  In Expo Go the device screen says so and nothing is registered. A blocked
  test push in dev is safe mode doing its job: put your own (verified)
  account email in `OUTBOUND_SAFE_RECIPIENTS`. `InvalidCredentials` receipts
  mean the APNs key / FCM credentials are missing in EAS (`eas credentials`).
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
  picked up is red too. The gate forces `LLM_ENABLED=false` (free, deterministic)
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
  entrypoint. The resolved root is logged at startup. `setup.sh` writes an
  absolute `<repo>/storage` into a NEW `.env` so web and worker share it (an
  existing `.env` is never rewritten; it prints a hint). The path is absolute,
  so **moving or re-cloning the repo leaves it pointing at the old place** —
  update it. The compose files override it with the container volume path.
- **Current Claude models 400 on `temperature`/`top_p`/`top_k`, on disabled
  thinking, and on forced `tool_choice`.** `packages/ai/src/providers/anthropic.ts`
  sends none of them; depth is `output_config.effort` (set explicitly — Opus 5.5
  defaults to medium). Do not "add temperature for determinism".
- **Azure/OpenAI reasoning models reject `max_tokens`.** They go through
  `@ai-sdk/azure`/`@ai-sdk/openai`, which send `max_completion_tokens`; the
  generic OpenAI-compatible provider is only for `local/`, OpenRouter, DeepSeek.
  Name Azure deployments after the model (`gpt-5`), or detection by name fails.
- **A model string with an unknown prefix is an error, not a bare name** — in
  CODE. From .env, with a custom `LLM_BASE_URL`, a prefix whose provider has no
  key (or no provider at all) is read as a whole model id on that URL (legacy
  mode, warned at boot). `local/meta-llama/…` says it explicitly.
- **Only Claude Opus/Sonnet/Haiku 5.5 are priced built in.** Everything else
  needs `LLM_PRICES`; with a cap set, discretionary calls on an unpriced model
  are refused (`LlmUnpricedError`). The boot log lists every unpriced tier.
- **A failed call whose cost is unknown** (timeout, dropped stream, killed CLI)
  is recorded `costKnown=false` with its estimate still counted against the cap.
  An HTTP error status from the provider is recorded as $0.
- **`cli/` runs `claude -p` one call at a time** from an empty temp dir, tools
  off, a neutral system prompt, and an allowlisted environment: an
  `ANTHROPIC_API_KEY` in the app's env would otherwise silently switch it from
  the subscription login to the paid key, and the app's secrets would leak to
  it. The timeout includes the queue wait. In Docker there is no `claude`: use
  `scripts/claude-bridge` on the host (`ops/systemd/claude-bridge.service`),
  bound to loopback or this host's tailscale address only; it caps its queue
  (503) and kills a run whose client hung up.
- **`npm run ai:live` spends real money** on every configured provider. It is
  never part of `make test` or CI; unit tests use fakes and stay offline.
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
- **better-auth's rate limiter counts in Redis** (`customStorage` in
  packages/auth), shared by every web replica; `AUTH_RATE_LIMIT_*` still set
  the limits. better-auth consults it on EVERY `/api/auth/*` request (session
  checks included), so if Redis is down it falls back to a per-process memory
  limiter with a warning, rather than taking the whole app down.
- **OAuth tokens are encrypted at rest** (`account.encryptOAuthTokens`), keyed
  by `BETTER_AUTH_SECRET`: rotating that secret makes stored tokens unreadable
  and users must re-link Google.
- **Deleting an organization deletes its audit rows** (cascade). The deletion
  itself is recorded as a global `org.delete` audit event (organizationId null).
- **Machine-to-machine endpoints fail closed.** `requireCronAuth` /
  `verifyHmac` from `@repo/security` refuse every request in production when
  their secret is unset (outside production an unset secret is allowed).
  Third-party tokens at rest go through `sealSecret`/`openSecret`.
- **Rollback swaps code, not schema.** `deploy.sh` migrates forward before
  the swap, so a rolled-back image runs on the NEW schema. Migrations must
  keep the previous code working: add a column, backfill it, and drop the old
  one in a later deploy. `deploy.sh` refuses new migrations that drop, rename,
  retype or add NOT NULL unless `--allow-destructive`
  (`scripts/lib/migration-guard.sh`). Every deploy also takes a `pre-deploy`
  dump right before migrating.
- **Prod has two env files.** `.env.production` holds the app's settings and
  goes to the containers through `env_file` only; the scripts never source it.
  `.env.deploy` holds ops settings: `POSTGRES_PASSWORD`, `PROD_WEB_PORT` (not
  the dev `WEB_PORT`), `DEPLOY_*`, `BACKUP_*` and the tunnel token. It is
  sourced by the scripts and used for compose interpolation, and is never
  handed to the app. Pin `DEPLOY_PROJECT` there: the default `<dir>-prod`
  means renaming the directory points at new, empty volumes. Because
  `.env.deploy` is sourced with `set -a`, a value it sets beats an inline
  `VAR=x scripts/...` override.
- **`backups/` and `.deploy/` must stay in `.dockerignore`.** Without that,
  every image build ships the database dumps into the build context.
- **A deploy started from inside a systemd service must run in its own unit**
  (`scripts/deploy.sh --detach`, or `systemctl --user start <app>-deploy`).
  `setsid nohup` leaves it in the caller's cgroup; stopping the caller kills
  the deploy halfway.
- **The desktop shell (apps/desktop) is a browser, not a client.** It loads
  the deployed `APP_URL` and gets NO Tauri IPC in that window: no capability
  names it, and `src-tauri/src/tests.rs` fails if one ever does. Do not "just
  add a command" for the web app to call; the only page with commands is the
  bundled setup screen (`ui/`). Its notifications come from `desktop.feed` (a
  tRPC query, polled with the window's own session cookie); change what it
  notifies about there, in TypeScript. Its npm scripts are deliberately NOT
  named build/dev/test/lint/typecheck, so turbo and the gates never compile
  Rust; keep it that way (`make desktop`, `make desktop-build`).
- Mobile has one `@ts-expect-error` on the better-auth Expo plugin: an upstream
  generic-variance gap in 1.6.25. Suppressed rather than cast so session types
  still infer. Remove it when upstream types line up.

## Starting a real app from this template

1. Rename: in `.env`, `APP_SCHEME` (server AND app read it), `MOBILE_APP_NAME`,
   `MOBILE_APP_SLUG`, `MOBILE_BUNDLE_ID` (iOS bundle id and Android package),
   and after `cd apps/mobile && npx eas init`, `EAS_PROJECT_ID` (+ `EXPO_OWNER`).
   `apps/mobile/app.config.ts` reads them (defaults there); set the same as EAS
   environment variables for cloud builds. Rename BEFORE the first release:
   `APP_SCHEME` is also the prefix of the SecureStore key holding the session
   cookie (`storagePrefix` in `apps/mobile/lib/auth.ts`), so changing it in
   an update signs every mobile user out; `MOBILE_BUNDLE_ID` is the store
   identity (a new one is a new app). Then the `<title>` in `apps/web/src/app/layout.tsx`,
   `apps/web/src/app/manifest.ts` and `icon.svg`. Desktop: `productName`,
   `mainBinaryName` and `identifier` in `apps/desktop/src-tauri/tauri.conf.json` (the identifier
   names users' settings dir: never change it after a release), then
   `npm run icons -w desktop` (regenerated from `icon.svg`). The desktop
   shell has no URL scheme (no deep links yet), so `APP_SCHEME` is mobile's.
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
