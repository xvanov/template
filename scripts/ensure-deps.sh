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
