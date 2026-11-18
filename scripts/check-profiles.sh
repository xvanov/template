#!/usr/bin/env bash
# Fast check that every profile still GENERATES (seconds; run by ci.yml):
# the scaffolder's unit tests, then each profile through scripts/new-app.mjs
# without install or git, which fails on any malformed or unknown @module
# marker, an unclosed block, a migration it cannot trim, or a leftover
# reference to a removed module. With CHECK_DB_URL (a Postgres server URL,
# no database) the `web` profile's trimmed migrations are also applied to an
# empty database and compared with its trimmed schema.
#
# The full gates of every generated app (install, typecheck, tests, smoke)
# are scripts/test-profiles.sh, in .github/workflows/profiles.yml.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/check-profiles.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

node --test "$ROOT/scripts/new-app.test.mjs" >"$TMP/unit.log" 2>&1 || {
  cat "$TMP/unit.log"
  exit 1
}

mapfile -t PROFILES < <(node -e 'console.log(Object.keys(require(process.argv[1]).profiles).join("\n"))' "$ROOT/template/modules.json")
for p in "${PROFILES[@]}"; do
  node "$ROOT/scripts/new-app.mjs" "$TMP/$p" --profile "$p" --no-install --no-git >"$TMP/$p.log" 2>&1 || {
    cat "$TMP/$p.log"
    exit 1
  }
  echo "✓ $p generates"
done

if [ -n "${CHECK_DB_URL:-}" ]; then
  db="check_$(date +%s)_$RANDOM"
  cd "$TMP/web/packages/db"
  ln -s "$ROOT/node_modules" "$TMP/web/node_modules" # the template's Prisma CLI
  printf 'CREATE DATABASE "%s";\n' "$db" | DATABASE_URL="$CHECK_DB_URL/postgres" npx --no-install prisma db execute --stdin >>"$TMP/db.log" 2>&1
  rc=0
  {
    DATABASE_URL="$CHECK_DB_URL/$db?schema=public" npx --no-install prisma migrate deploy >>"$TMP/db.log" 2>&1 &&
      DATABASE_URL="$CHECK_DB_URL/$db?schema=public" npx --no-install prisma migrate diff \
        --from-config-datasource --to-schema prisma/schema.prisma --exit-code >>"$TMP/db.log" 2>&1
  } || rc=$?
  printf 'DROP DATABASE "%s" WITH (FORCE);\n' "$db" | DATABASE_URL="$CHECK_DB_URL/postgres" npx --no-install prisma db execute --stdin >>"$TMP/db.log" 2>&1
  if [ "$rc" -ne 0 ]; then
    cat "$TMP/db.log" >&2
    echo "✗ web: trimmed migrations do not match the trimmed schema" >&2
    exit 1
  fi
  echo "✓ web: trimmed migrations == trimmed schema"
fi
