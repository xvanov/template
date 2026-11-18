# Modules, markers and profiles

How `scripts/new-app.sh` turns this repo into a smaller app, and what that
asks of anyone changing the template. Everything here is template-only: none
of it is copied into a generated app.

## The pieces

- **`template/modules.json`** — every module: what it is, what it `requires`
  (pulled in automatically), the `paths` it owns (deleted with it), its
  database `tables`, its `env` keys, npm deps and root scripts it adds to
  shared `package.json` files, and `leftovers`: regexes that must match
  nothing once it is removed. `profiles` are named module sets.
- **Markers** — for shared files that a module adds lines to (routers,
  job registry, env schema, nav, `.env.example`, Makefile, CI, docs). Any
  comment style works (`//`, `#`, `--`, `<!-- -->`, `{/* */}`):

  ```ts
  import { inboxRouter } from "./routers/inbox"; // @module:inbound   ← this line only
  // @module:agent                                                     ← a block
  ...
  // @end
  ```

  The expression after `@module:` is a module id, `a,b` (both present), `a|b`
  (either) or `!a` (only without a). Blocks nest. In the generated app the
  markers of kept code are stripped, so it carries no trace of them.

- **`scripts/new-app.mjs`** — no dependencies, runs before `npm install`.
  It copies the files git would commit, deletes unselected modules' paths,
  applies the markers, prunes migrations, edits the JSON it cannot mark
  (`package.json` deps and scripts, `turbo.json` `globalEnv`, `eas.json`
  env), renames, writes the app's `CLAUDE.md` / `README.md` from
  `template/app/`, refuses to finish if any `leftovers` (or a removed
  module's env key) remain, then installs, runs prettier and commits.

## Database: migrations are pruned, never squashed

Applied migrations are never edited in the template (Prisma checksums them,
so an edit breaks every existing database). Instead the generator removes,
from each migration, every statement that names a removed module's table
(`tables` in the manifest) — `CREATE TABLE`, its indexes, foreign keys,
`ALTER TABLE` — and deletes migrations left with nothing; a module's own
migration directories are in its `paths` (which also takes extension
statements like pgvector's with it). The Prisma schema uses markers. So a
generated app has the same history as the template, minus those statements,
and its hand-written SQL survives. `scripts/test-profiles.sh` proves it per
profile: the pruned migrations, applied to an empty database, must equal the
pruned schema (`prisma migrate diff --exit-code`).

Rule for a new module: put its tables in migrations of their own when you
can; when a migration mixes modules, list the tables in `tables`. A
`$$` function body that touches a module's table is refused, not guessed.

## Adding or changing a module

1. Own files by path when you can (a router file, a page, a test file) —
   cheaper and safer than markers. Mark only the lines a module adds to
   shared files.
2. Removing a module must leave working code: no dangling import, no
   unreachable code, no empty union. Put the module's work behind a function
   or a block the core does not depend on (see `items.summarize` in
   `packages/jobs/src/handlers.ts`, `glanceSnapshot` sections, the desktop
   feed). Core must never import a module package.
3. Watch prettier: a marked line it later joins with another (a short union,
   an array) cuts too much. Prefer one item per line with a block, and run
   `npm run format:check`.
4. Add `leftovers` patterns for the module's names (package, routes,
   tables), then run `scripts/test-profiles.sh` for the profiles without it.

## Testing

`scripts/test-profiles.sh [profile ...]` generates each profile into a temp
dir and runs format, typecheck, lint, unit + integration tests, the
migration check, and `make smoke` for `web` and `hackathon` (set
`SMOKE_PROFILES=all` for every one). `.github/workflows/profiles.yml` runs
it in CI, one job per profile: on demand, weekly, and on changes to
`template/` or the scripts.

## Design decisions

- **Core** is everything every app needs: web + API, worker + jobs, auth +
  organizations, storage, the outbound guard with email, operator alerts,
  the UI kit, the smoke gate. `notify` is core because auth, the worker and
  the AI cap alert all use it.
- The outbound guard keeps its `sms` and `mobile_push` policy (pure,
  unit-tested, switched off by default) even without those modules: the
  single security gate stays one piece of code instead of a different build
  per app. Only the push-device lookup is marked.
- `full` is exactly this repo; there is no separate source of truth.
