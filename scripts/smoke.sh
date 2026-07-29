#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# THE MERGE GATE.
#
# Unit tests pass on an application that does not boot. This script builds the
# app for production, boots it on an isolated port with a real Postgres and a
# real Redis, waits for its health endpoint to report every dependency
# reachable, then drives the actual user journey through a browser.
#
#   ./scripts/smoke.sh
#
# Exits non-zero on the first failure and always tears down what it started.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# An isolated port so a dev server on :3200 does not get mistaken for the build
# under test — that mistake is how a green gate ends up meaning nothing.
PORT="${SMOKE_PORT:-3210}"
BASE_URL="http://127.0.0.1:${PORT}"
SERVER_PID=""

cleanup() {
  local code=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "→ stopping server (pid $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  exit $code
}
trap cleanup EXIT INT TERM

if [ ! -f .env ]; then
  echo "✗ no .env — run ./scripts/setup.sh first" >&2
  exit 1
fi
set -a; . ./.env; set +a

# Refuse to run against a server we did not start. Otherwise a stale process
# left on this port answers the health check and the gate reports on the wrong
# binary — passing or failing for reasons that have nothing to do with the build.
if (command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ":${PORT} ") ||
  curl -fsS --max-time 2 "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "✗ port ${PORT} is already in use — the gate must own it." >&2
  echo "  Free it (e.g. kill the pid from: ss -ltnp | grep :${PORT}) or set SMOKE_PORT." >&2
  exit 1
fi

echo "→ infrastructure"
# A real SMTP server is not optional here: the journey confirms a real emailed
# link. It is the DEDICATED test catcher (mailpit-test, :1036/:8036), never the
# dev inbox — the suite's links point at this run's isolated port and go dead
# when it ends, so mixing them into your own inbox turns real mail into noise.
docker compose up -d db redis >/dev/null
docker compose --profile test up -d mailpit-test >/dev/null
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' app-db 2>/dev/null || echo x)" = healthy ] &&
    [ "$(docker inspect -f '{{.State.Health.Status}}' app-redis 2>/dev/null || echo x)" = healthy ] &&
    [ "$(docker inspect -f '{{.State.Health.Status}}' app-mailpit-test 2>/dev/null || echo x)" = healthy ] && break
  sleep 1
done

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
# NOTE the override names: `.env` was sourced above with `set -a`, so SMTP_PORT
# and MAILPIT_URL are ALREADY exported. A `${SMTP_PORT:-1036}` default would
# therefore never apply, and the gate would quietly mail your dev inbox instead
# of the throwaway one. Overrides get their own SMOKE_* names for that reason.
PORT="$PORT" HOSTNAME=127.0.0.1 \
APP_URL="$BASE_URL" BETTER_AUTH_URL="$BASE_URL" \
AUTH_RATE_LIMIT_MAX="${AUTH_RATE_LIMIT_MAX:-5000}" \
SMTP_HOST=localhost SMTP_PORT="${SMOKE_SMTP_PORT:-1036}" \
REQUIRE_EMAIL_VERIFICATION=true \
DEV_MAIL_INBOX_URL= \
  node "${STANDALONE}/server.js" > /tmp/smoke-web.log 2>&1 &
SERVER_PID=$!

echo "→ waiting for health"
READY=0
for _ in $(seq 1 60); do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then READY=1; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "✗ the server exited during boot:" >&2
    tail -40 /tmp/smoke-web.log >&2
    exit 1
  fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "✗ /api/health never became reachable:" >&2
  tail -40 /tmp/smoke-web.log >&2
  exit 1
fi
curl -fsS "${BASE_URL}/api/health"
echo

echo "→ driving the user journey"
# MAILPIT_URL points the suite at the test catcher's API, matching SMTP_PORT above.
BASE_URL="$BASE_URL" MAILPIT_URL="${SMOKE_MAILPIT_URL:-http://localhost:8036}" \
  npm run test:e2e:smoke --workspace web

echo
echo "✓ smoke passed: the built app boots and the core journey works"
