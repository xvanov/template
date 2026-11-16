#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Make a bare checkout runnable. Idempotent and cheap when already satisfied.
#
#   bash scripts/ensure-deps.sh
#
# Every gate command is prefixed with this because CI and the software factory
# run them inside a fresh git worktree: no node_modules, no generated Prisma
# client. A gate that assumes those exist cannot run there, and "the gate is
# red" then means "the checkout was empty", which tells you nothing.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -d node_modules ]; then
  echo "→ installing dependencies (bare checkout)"
  # `ci`, not `install`: the lockfile is the contract, and a gate must test the
  # dependency tree that was committed rather than resolve a new one.
  npm ci --no-audit --fund=false
fi

if [ ! -d packages/db/generated ]; then
  echo "→ generating the Prisma client"
  npm run db:generate
fi

# Integration tests (*.int.test.ts, part of `npm run test`) need Postgres. Only
# HINT here: starting it would make a worktree spin up a second compose project
# fighting the main checkout for the same port.
db_url="${TEST_DATABASE_URL:-$(grep -E '^DATABASE_URL=' .env 2>/dev/null | cut -d= -f2- | tr -d "\"'" || true)}"
db_url="${db_url:-postgresql://postgres:postgres@localhost:5442/app}"
hostport="${db_url#*@}"
hostport="${hostport%%[/?]*}"
db_host="${hostport%%:*}"
db_port="${hostport##*:}"
[ "$db_port" = "$hostport" ] && db_port=5432
if ! timeout 1 bash -c ">/dev/tcp/$db_host/$db_port" 2>/dev/null; then
  echo "! Postgres is not reachable at $db_host:$db_port; integration tests will fail." >&2
  echo "  Start it from the main checkout with \`make up\`, or set TEST_DATABASE_URL." >&2
fi
