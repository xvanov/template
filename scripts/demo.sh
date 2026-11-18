#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# One command from a clone to a running demo with data in it.
#
#   ./scripts/demo.sh             (make demo) infra, migrate, seed, web + worker
#   ./scripts/demo.sh --seed-only  just (re)seed the demo workspace
#
# Brings up Postgres/Redis/Mailpit, applies migrations, seeds a demo
# workspace (a user who can sign in at once, items, a searchable document, an
# inbox message), starts the web app and the worker, and prints the URL and
# the credentials. Ctrl-C stops both. Works with the AI off.
#
# A fresh clone (no .env or no node_modules) runs scripts/setup.sh first.
# Overrides (distinct names on purpose: .env is sourced with set -a):
#   DEMO_EMAIL     [demo@example.com]
#   DEMO_PASSWORD  [demo-password]
# The web port is WEB_PORT from .env; APP_URL must use the same port.
# Logs: logs/demo-web.log, logs/demo-worker.log.
#
# Development servers, for a laptop demo. Never seed this on a public
# deployment: the credentials are printed here and written in the docs.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

SEED_ONLY=0
case "${1:-}" in
  --seed-only) SEED_ONLY=1 ;;
  "") ;;
  *) sed -n '2,22p' "$0"; exit 2 ;;
esac
EMAIL="${DEMO_EMAIL:-demo@example.com}"
PASSWORD="${DEMO_PASSWORD:-demo-password}"

if [ ! -f .env ] || [ ! -x node_modules/.bin/turbo ]; then
  bold "first run: scripts/setup.sh"
  bash scripts/setup.sh
fi
set -a
# shellcheck source=/dev/null  # per-machine file
. ./.env
set +a
PORT="${WEB_PORT:-3200}"
URL="${APP_URL:-http://localhost:$PORT}"
if [[ "$URL" =~ ^https?://(localhost|127\.0\.0\.1)(:([0-9]+))? ]] && [ "${BASH_REMATCH[3]:-80}" != "$PORT" ]; then
  die "APP_URL ($URL) and WEB_PORT ($PORT) disagree: sign-in would fail with \"Invalid origin\". Make them match in .env."
fi

bold "1/4  postgres + redis + mail"
# Quiet unless it fails: compose and prisma narrate every step on stderr.
quiet() {
  local out
  if ! out="$("$@" 2>&1)"; then
    echo "$out" >&2
    die "failed: $*"
  fi
}
quiet docker compose up -d --wait db redis mailpit
bash scripts/lib/collation.sh
ok "up"

bold "2/4  migrations"
quiet npm run --silent db:deploy
ok "applied"

bold "3/4  demo data"
npm run --silent demo:seed -w worker -- --email "$EMAIL" --password "$PASSWORD"
if [ "$SEED_ONLY" = 1 ]; then exit 0; fi

bold "4/4  web + worker"
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  die "port $PORT is in use (make dev already running?). Stop it, or change WEB_PORT and APP_URL."
fi
mkdir -p logs
WEB_LOG="$ROOT/logs/demo-web.log"
WORKER_LOG="$ROOT/logs/demo-worker.log"
WEB_PID=""
WORKER_PID=""
cleanup() {
  trap - EXIT INT TERM
  local pid
  for pid in "$WEB_PID" "$WORKER_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  echo "demo stopped"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

(cd apps/worker && exec "$ROOT/node_modules/.bin/tsx" src/index.ts) >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!
(cd apps/web && PATH="$ROOT/node_modules/.bin:$PATH" exec node scripts/with-root-env.mjs next dev --port "$PORT") >"$WEB_LOG" 2>&1 &
WEB_PID=$!

for _ in $(seq 1 180); do
  kill -0 "$WEB_PID" 2>/dev/null || { tail -30 "$WEB_LOG" >&2; die "the web app exited (log above: $WEB_LOG)"; }
  kill -0 "$WORKER_PID" 2>/dev/null || { tail -30 "$WORKER_LOG" >&2; die "the worker exited (log above: $WORKER_LOG)"; }
  if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$PORT/api/health")" = 200 ] \
    && grep -q '\[worker\] up' "$WORKER_LOG"; then
    break
  fi
  sleep 1
done
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$PORT/api/health")" = 200 ] \
  || die "the web app did not become healthy in 3 minutes (see $WEB_LOG)"
# next dev compiles a page on its first request: do it now, not in front of the judges.
for path in / /login; do curl -s -o /dev/null -m 120 "http://127.0.0.1:$PORT$path" || true; done
ok "running"

cat <<EOF

  Demo is up:  $URL
  Sign in:     $EMAIL  /  $PASSWORD

  Try:  Dashboard → the items, and the background jobs that ran
        Documents → search "warranty" or "reschedule"
        Inbox → a customer asking to move a visit · /design for the UI kit
  Mail: http://localhost:${MAIL_UI_PORT:-8035}   Logs: logs/demo-web.log, logs/demo-worker.log

  Ctrl-C stops the web app and the worker (Postgres/Redis keep running: make down).

EOF
wait "$WEB_PID"
