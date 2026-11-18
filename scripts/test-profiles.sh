#!/usr/bin/env bash
# Functions here run through `step` ("$@") and traps, which shellcheck cannot follow.
# shellcheck disable=SC2317
# ──────────────────────────────────────────────────────────────────────────
# Generate an app from every profile (or the ones named) and run its gates.
#
#   scripts/test-profiles.sh                       # every profile, smoke for web + hackathon
#   scripts/test-profiles.sh web mobile            # just these
#   SMOKE_PROFILES=all scripts/test-profiles.sh    # smoke every profile (slow)
#   SMOKE_PROFILES= scripts/test-profiles.sh       # no smoke at all
#   PLAYWRIGHT_INSTALL=1 ...                       # install Chromium before smoke (CI)
#
# The generator copies what git tracks (committed or staged): `git add` new
# files before testing them.
#
# Per profile, in a fresh directory: scripts/new-app.mjs (copy, cut modules,
# npm install, prettier, git init), then
#   format     npm run format:check
#   typecheck  turbo typecheck
#   lint       make lint (eslint + shellcheck)
#   test       turbo test --force (unit + integration, real Postgres + Redis)
#   migrations the pruned migrations, applied to an empty database, equal the
#              pruned schema (prisma migrate diff --exit-code)
#   smoke      scripts/smoke.sh (production build, booted, browser journey)
#
# Postgres (pgvector) and Redis: TEST_PG_URL (server URL, no database) and
# TEST_REDIS_URL if set (CI), else throwaway containers started here.
# Results: a table at the end, and $PROFILES_OUT/results.tsv. Exit 1 if any
# step failed. Generated apps are kept in $PROFILES_OUT (default: a temp dir).
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${PROFILES_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/profiles.XXXXXX")}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)" # absolute: every step runs from another directory
SMOKE_PROFILES="${SMOKE_PROFILES-web,hackathon}"

if [ $# -gt 0 ]; then
  PROFILES=("$@")
else
  mapfile -t PROFILES < <(node -e 'const m=require(process.argv[1]);console.log(Object.keys(m.profiles).join("\n"))' "$ROOT/template/modules.json")
fi

STARTED=()
cleanup() {
  local c
  for c in "${STARTED[@]:-}"; do
    if [ -n "$c" ]; then docker rm -f "$c" >/dev/null 2>&1 || true; fi
  done
}
trap cleanup EXIT

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

# ── Postgres + Redis for the integration tests ───────────────────────────
if [ -z "${TEST_PG_URL:-}" ]; then
  PG_PORT="$(free_port)"
  name="profiles-pg-$$"
  docker run -d --rm --name "$name" -p "127.0.0.1:${PG_PORT}:5432" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=app \
    -e POSTGRES_INITDB_ARGS="--locale-provider=builtin --builtin-locale=C.UTF-8" \
    pgvector/pgvector:0.8.6-pg17-bookworm >/dev/null
  STARTED+=("$name")
  TEST_PG_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}"
  for _ in $(seq 1 60); do
    docker exec "$name" pg_isready -U postgres -d app >/dev/null 2>&1 && break
    sleep 1
  done
fi
if [ -z "${TEST_REDIS_URL:-}" ]; then
  REDIS_PORT_T="$(free_port)"
  name="profiles-redis-$$"
  docker run -d --rm --name "$name" -p "127.0.0.1:${REDIS_PORT_T}:6379" redis:7-alpine >/dev/null
  STARTED+=("$name")
  TEST_REDIS_URL="redis://127.0.0.1:${REDIS_PORT_T}"
fi

# One SQL statement against the server's `postgres` database (run in an app
# dir: its Prisma CLI).
pg() {
  printf '%s\n' "$1" | (cd packages/db && DATABASE_URL="${TEST_PG_URL}/postgres" npx --no-install prisma db execute --stdin >/dev/null)
}

RESULTS="$OUT/results.tsv"
printf 'profile\tstep\tstatus\tseconds\n' >"$RESULTS"
FAILED=0

# step <profile> <name> <cmd...>: run in the app dir, log to <dir>.<name>.log
step() {
  local profile=$1 name=$2 dir="$OUT/$1" t0 status
  shift 2
  t0=$(date +%s)
  [ -d "$dir" ] || dir="$OUT"
  if (cd "$dir" && "$@") >"$OUT/$profile.$name.log" 2>&1; then status=ok; else status=FAIL; FAILED=1; fi
  printf '%s\t%s\t%s\t%s\n' "$profile" "$name" "$status" "$(($(date +%s) - t0))" >>"$RESULTS"
  printf '  %-11s %-4s %4ss\n' "$name" "$status" "$(($(date +%s) - t0))"
  if [ "$status" = FAIL ]; then
    tail -40 "$OUT/$profile.$name.log" | sed 's/^/    | /'
    return 1
  fi
}

migrations_match_schema() { # in the app dir
  local db
  db="tp_$(date +%s)_$RANDOM"
  pg "CREATE DATABASE \"$db\""
  local rc=0
  local url="${TEST_PG_URL}/${db}?schema=public"
  (
    cd packages/db
    DATABASE_URL="$url" npx --no-install prisma migrate deploy
    DATABASE_URL="$url" npx --no-install prisma migrate diff \
      --from-config-datasource --to-schema prisma/schema.prisma --exit-code
  ) || rc=$?
  pg "DROP DATABASE \"$db\" WITH (FORCE)"
  return "$rc"
}

for profile in "${PROFILES[@]}"; do
  dir="$OUT/$profile"
  echo "── $profile"
  rm -rf "$dir"
  step "$profile" generate node "$ROOT/scripts/new-app.mjs" "$dir" --profile "$profile" --name "Test ${profile}" || continue

  export DATABASE_URL="${TEST_PG_URL}/app?schema=public"
  export TEST_DATABASE_URL="${TEST_PG_URL}/app"
  export REDIS_URL="$TEST_REDIS_URL" TEST_REDIS_URL
  export BETTER_AUTH_SECRET="profiles-test-secret-not-for-production-00"

  step "$profile" format npm run format:check || true
  step "$profile" typecheck npx --no-install turbo run typecheck --continue --output-logs=errors-only || true
  step "$profile" lint make lint || true
  step "$profile" test npx --no-install turbo run test --force --continue --output-logs=errors-only || true
  step "$profile" migrations migrations_match_schema || true

  if [ "$SMOKE_PROFILES" = all ] || [[ ",$SMOKE_PROFILES," == *",$profile,"* ]]; then
    if [ "${PLAYWRIGHT_INSTALL:-0}" = 1 ]; then # CI: the app's own browser build
      step "$profile" browsers npx --no-install playwright install chromium --only-shell --with-deps || true
    fi
    # smoke.sh starts its own isolated stack; it must not see this script's URLs.
    step "$profile" smoke env -u DATABASE_URL -u TEST_DATABASE_URL -u REDIS_URL -u TEST_REDIS_URL \
      bash scripts/smoke.sh || true
  fi
done

echo
echo "── summary ($OUT)"
column -t -s $'\t' "$RESULTS"
awk -F'\t' 'NR>1 {t[$1]+=$4} END {for (p in t) printf "  %-10s %ss total\n", p, t[p]}' "$RESULTS"
exit "$FAILED"
