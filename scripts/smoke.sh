#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# THE MERGE GATE.
#
# Unit tests pass on an application that does not boot. This script builds the
# app for production, boots it AND the background worker on an isolated port
# with a real Postgres, Redis and mail catcher, waits for both to report ready,
# then drives the actual user journey through a browser — including a job that
# the worker must pick up and finish.
#
#   ./scripts/smoke.sh
#
# Exits non-zero on the first failure and always tears down what it started.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SERVER_PID=""
WORKER_PID=""
SMOKE_TMP=""

# Last lines of both process logs. Called on ANY failure, so whichever step
# broke, the reason is on screen instead of in a file nobody opens.
dump_logs() {
  local f
  for f in "${WEB_LOG:-}" "${WORKER_LOG:-}"; do
    { [ -n "$f" ] && [ -s "$f" ]; } || continue
    echo "── last 60 lines of $(basename "$f") ──" >&2
    tail -60 "$f" >&2
  done
}

cleanup() {
  local code=$?
  trap - EXIT
  trap '' INT TERM # a second Ctrl-C must not skip the teardown below
  [ "$code" -ne 0 ] && dump_logs
  local pid
  for pid in "$SERVER_PID" "$WORKER_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "→ stopping pid $pid"
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  # Tear down this run's own stack (volumes included — it is throwaway state).
  # Without this, every CI run and every factory story leaks a Postgres.
  if [ "${SMOKE_KEEP_STACK:-0}" != "1" ]; then
    docker compose --profile test down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  # Logs + throwaway storage. Kept on failure so they can be read in full.
  if [ -n "$SMOKE_TMP" ]; then
    if [ "$code" -ne 0 ] && [ -s "${WEB_LOG:-}" ]; then
      echo "  full logs kept in $SMOKE_TMP" >&2
    else
      rm -rf "$SMOKE_TMP"
    fi
  fi
  exit $code
}
# Signals get their OWN traps that exit non-zero; cleanup runs once, from EXIT.
# Trapping INT/TERM straight to cleanup would read `$?` from the interrupted
# foreground command — often 0 — and a gate killed by timeout(1), a watchdog or
# `docker stop` would report GREEN.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Load .env FIRST, for the app's own settings (secret, feature flags) …
# shellcheck source=/dev/null  # .env is per-machine; absent in a fresh checkout (CI)
if [ -f .env ]; then set -a; . ./.env; set +a; fi

# ── isolation (MUST come after sourcing .env) ─────────────────────────────
# ORDER IS LOAD-BEARING. A git worktree created by the factory contains the
# app's .env, which sets DB_PORT/REDIS_PORT to the DEV stack's ports. Exporting
# these before `. ./.env` lets the file clobber them, and the gate then tries to
# bind ports the running dev stack already owns — "port is already allocated",
# on every story. Overrides win only if they are applied last.
#
# This script must run ANYWHERE — a throwaway worktree, CI — while the dev stack
# is up, so it shares nothing with development:
#
#   * its own Compose project, DB, Redis, mail and web ports
#   * ports DERIVED FROM THIS DIRECTORY, so two worktrees checked out at once
#     (the factory runs stories concurrently) do not collide either
#
# Override any of them with the SMOKE_* variables.
dir_port() { # dir_port <base> <span> → a stable port for this directory
  local base=$1 span=$2 h
  h=$(printf '%s' "$ROOT" | cksum | cut -d' ' -f1)
  echo $((base + h % span))
}

PORT="${SMOKE_PORT:-$(dir_port 3300 60)}"
export COMPOSE_PROJECT_NAME="${SMOKE_PROJECT:-smoke-$(basename "$ROOT")}"
export DB_PORT="${SMOKE_DB_PORT:-$(dir_port 5500 60)}"
export REDIS_PORT="${SMOKE_REDIS_PORT:-$(dir_port 6500 60)}"
export TEST_MAIL_SMTP_PORT="${SMOKE_MAIL_SMTP_PORT:-$(dir_port 1500 60)}"
export TEST_MAIL_UI_PORT="${SMOKE_MAIL_UI_PORT:-$(dir_port 8500 60)}"

BASE_URL="http://127.0.0.1:${PORT}"

# … and point the app at THIS run's stack, not the dev one.
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/app?schema=public"
export REDIS_URL="redis://127.0.0.1:${REDIS_PORT}"
export SMTP_HOST=127.0.0.1
export SMTP_PORT="${TEST_MAIL_SMTP_PORT}"
# A bare worktree may have no .env; without a secret better-auth refuses to boot.
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-smoke-gate-secret-not-for-production-32}"

# Nothing the gate writes may outlive it or land in the dev tree: logs and
# uploaded files go to a fresh temp dir (absolute, so every process agrees on
# it — see STORAGE_LOCAL_DIR in CLAUDE.md). The LLM is forced OFF whatever the
# dev .env says: the gate must not spend money or depend on a third party, and
# the worker's summary job has a deterministic no-LLM path.
SMOKE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/smoke-$(basename "$ROOT").XXXXXX")"
WEB_LOG="${SMOKE_TMP}/web.log"
WORKER_LOG="${SMOKE_TMP}/worker.log"
export STORAGE_DRIVER=local STORAGE_LOCAL_DIR="${SMOKE_TMP}/storage"
export LLM_API_KEY=""

# Refuse to run against a server we did not start. Otherwise a stale process
# left on this port answers the health check and the gate reports on the wrong
# binary — passing or failing for reasons that have nothing to do with the build.
if (command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ":${PORT} ") ||
  curl -fsS --max-time 2 "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "✗ port ${PORT} is already in use — the gate must own it." >&2
  echo "  Free it (e.g. kill the pid from: ss -ltnp | grep :${PORT}) or set SMOKE_PORT." >&2
  exit 1
fi

echo "→ dependencies"
bash scripts/ensure-deps.sh

echo "→ infrastructure"
# A real SMTP server is not optional here: the journey confirms a real emailed
# link. It is the DEDICATED test catcher (mailpit-test, :1036/:8036), never the
# dev inbox — the suite's links point at this run's isolated port and go dead
# when it ends, so mixing them into your own inbox turns real mail into noise.
docker compose --profile test up -d --wait db redis mailpit-test >/dev/null
echo "  project=${COMPOSE_PROJECT_NAME} db=${DB_PORT} redis=${REDIS_PORT} mail=${TEST_MAIL_UI_PORT} web=${PORT}"

echo "→ migrations"
npm run db:deploy >/dev/null

echo "→ production build"
npm run build --workspace web

echo "→ assembling the standalone bundle"
# `output: standalone` traces server code only — the static chunks are NOT
# copied in. Without this step the server boots and serves HTML, every JS chunk
# 404s, nothing hydrates, and the gate fails in a way that looks like an app bug
# rather than a packaging one. The Dockerfile does the same two copies.
STANDALONE="apps/web/.next/standalone/apps/web"
rm -rf "${STANDALONE}/.next/static"
cp -r apps/web/.next/static "${STANDALONE}/.next/static"
[ -d apps/web/public ] && cp -r apps/web/public "${STANDALONE}/public"

# Per-run secrets for the machine endpoints (cron, webhook): the journey proves
# they refuse callers without them, and accept the server's own.
SMOKE_CRON_SECRET="smoke-cron-$(openssl rand -hex 16)"
SMOKE_WEBHOOK_SECRET="smoke-webhook-$(openssl rand -hex 16)"

echo "→ booting the built app on :${PORT}"
# Run the standalone server directly: that is the artifact the container runs,
# so it is the artifact the gate must test.
#
# APP_URL / BETTER_AUTH_URL are overridden to the port we actually serve on.
# better-auth checks the request origin against them, so a mismatch here surfaces
# as "Invalid origin" on every sign-in. Configure the origin truthfully rather
# than loosening the check — that check is a CSRF boundary.
#
# AUTH_RATE_LIMIT_MAX is raised because this suite signs up several accounts a
# second from one IP — exactly the traffic the limiter exists to stop. The
# limiter stays ENABLED; only its ceiling moves, and only for the gate.
#
# OUTBOUND_SAFE_MODE is forced ON with an EMPTY allowlist, whatever .env says.
# A production build would default it off; forcing it on makes the gate prove
# the decision that matters: in a safe-mode environment, sign-up's verification
# mail (auth mail to the address being signed up) still arrives, while any
# other mail to these throwaway addresses would be blocked and logged.
#
# NOTE the override names: `.env` was sourced above with `set -a`, so SMTP_PORT
# and MAILPIT_URL are ALREADY exported. A `${SMTP_PORT:-1036}` default would
# therefore never apply, and the gate would quietly mail your dev inbox instead
# of the throwaway one. Overrides get their own SMOKE_* names for that reason.
PORT="$PORT" HOSTNAME=127.0.0.1 \
APP_URL="$BASE_URL" BETTER_AUTH_URL="$BASE_URL" \
AUTH_RATE_LIMIT_MAX="${AUTH_RATE_LIMIT_MAX:-5000}" \
REQUIRE_EMAIL_VERIFICATION=true \
DEV_MAIL_INBOX_URL="" \
OUTBOUND_SAFE_MODE=true OUTBOUND_SAFE_RECIPIENTS="" OUTBOUND_FROZEN=false \
CRON_SECRET="$SMOKE_CRON_SECRET" EMAIL_WEBHOOK_SECRET="$SMOKE_WEBHOOK_SECRET" \
  node "${STANDALONE}/server.js" > "$WEB_LOG" 2>&1 &
SERVER_PID=$!

echo "→ booting the worker"
# The worker is part of the product: jobs and schedules run there, and a web app
# whose worker crashes on boot is a broken deploy. Same command the worker image
# runs (tsx, no bundle), same isolated environment as the server. Started
# directly with node — not via `npm run` — so the pid we kill is the worker
# itself and nothing is left orphaned.
APP_URL="$BASE_URL" node --import tsx apps/worker/src/index.ts > "$WORKER_LOG" 2>&1 &
WORKER_PID=$!

# A process that has exited is reported by name, with its log (via cleanup).
alive_or_die() { # alive_or_die <pid> <what>
  if ! kill -0 "$1" 2>/dev/null; then
    echo "✗ the $2 exited${3:+ $3}." >&2
    exit 1
  fi
}

echo "→ waiting for health and the worker"
WEB_READY=0 WORKER_READY=0
for _ in $(seq 1 60); do
  [ "$WEB_READY" -eq 1 ] || { curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1 && WEB_READY=1; }
  [ "$WORKER_READY" -eq 1 ] || { grep -q "\[worker\] up" "$WORKER_LOG" 2>/dev/null && WORKER_READY=1; }
  alive_or_die "$SERVER_PID" server "during boot"
  alive_or_die "$WORKER_PID" worker "during boot"
  [ "$WEB_READY" -eq 1 ] && [ "$WORKER_READY" -eq 1 ] && break
  sleep 1
done
[ "$WEB_READY" -eq 1 ] || { echo "✗ /api/health never became reachable." >&2; exit 1; }
[ "$WORKER_READY" -eq 1 ] || { echo "✗ the worker never printed its '[worker] up' line." >&2; exit 1; }
curl -fsS "${BASE_URL}/api/health"
echo
echo "  worker up (pid $WORKER_PID)"

echo "→ driving the user journey"
# MAILPIT_URL points the suite at the test catcher's API, matching SMTP_PORT above.
# EVERY e2e test runs — no tag filter — so a new test cannot silently run nowhere.
# On a failed journey, check the processes FIRST: "the worker died" is the real
# cause and must not be reported as a mere test failure.
BASE_URL="$BASE_URL" MAILPIT_URL="http://127.0.0.1:${TEST_MAIL_UI_PORT}" \
E2E_CRON_SECRET="$SMOKE_CRON_SECRET" E2E_EMAIL_WEBHOOK_SECRET="$SMOKE_WEBHOOK_SECRET" \
  npm run test:e2e --workspace web || {
  alive_or_die "$WORKER_PID" worker "during the journey"
  alive_or_die "$SERVER_PID" server "during the journey"
  echo "✗ the journey failed (both processes still up)." >&2
  exit 1
}

# A worker that died mid-run may still have let the journey pass (e.g. it
# finished the one job and then crashed). That is a failure too.
alive_or_die "$SERVER_PID" server "during the journey"
alive_or_die "$WORKER_PID" worker "during the journey"

echo
echo "✓ smoke passed: the built app and worker boot, and the core journey works"
