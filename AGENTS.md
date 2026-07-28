# AGENTS.md

Entry point for AGENTS.md-aware tools (OpenCode, Codex, Cursor, …).

**Read `CLAUDE.md` first — it is the full brief and it is short.** It covers the
layout, the one-command bootstrap, the gates, the architecture rules, and the
list of things that have already bitten someone here.

## The short version

```bash
./scripts/setup.sh   # .env + deps + postgres/redis + migrations (idempotent)
make dev             # web :3200 + worker
make mobile          # Expo dev server :8091 — scan with Expo Go
make smoke           # THE GATE: production build, booted, driven in a browser
```

## Rules you cannot violate

1. **The API is tRPC in `packages/api`.** Route handlers only for auth, file
   bytes and health.
2. **Org-scoped data goes through `orgProcedure`** and filters on
   `ctx.organizationId`. Mutations use `updateMany`/`deleteMany` with the org in
   the `where` — never `update`-by-id plus a separate ownership check.
3. **`env()` from `@repo/env`, never `process.env`.** Node entrypoints begin with
   `import "@repo/env/load"`.
4. **Importing a module must not connect to anything.** The db client, the auth
   instance and the Redis queue are lazy on purpose: `next build` walks the module
   graph, and a build must not require production secrets.
5. **`make smoke` is the definition of done.** Unit tests pass on an app that
   does not boot.
6. **Do not weaken a security control to make a test pass.** Rate limits,
   trusted origins and the upload allow-list are all configurable — configure
   them for the test, keep them on in production.

Ports: **web 3200 · postgres 5442 · redis 6389 · expo 8091** (non-default so this
coexists with other projects on the same machine).
