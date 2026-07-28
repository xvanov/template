#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# One-command bootstrap. Idempotent: safe to re-run.
#
#   ./scripts/setup.sh
#
# Creates .env (with a real secret and this machine's LAN address), installs
# dependencies, starts Postgres + Redis, applies migrations, and prints exactly
# what to run next.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

bold "1/5  checking tools"
command -v node >/dev/null || die "node is required (>= 22)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "node >= 22 required (found $(node -v))"
ok "node $(node -v)"
command -v docker >/dev/null || die "docker is required (for Postgres + Redis)"
docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"
ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"

bold "2/5  .env"
if [ -f .env ]; then
  ok ".env already exists (left untouched)"
else
  cp .env.example .env
  # A generated secret beats a placeholder nobody remembers to change.
  if command -v openssl >/dev/null; then
    SECRET="$(openssl rand -base64 32)"
  else
    SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
  fi
  # `|` delimiter: base64 contains slashes.
  sed -i.bak "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=${SECRET}|" .env && rm -f .env.bak
  ok "wrote .env with a generated BETTER_AUTH_SECRET"
fi

# The phone cannot reach "localhost" — point it at this machine on the LAN.
LAN_IP="$( (hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || true) | awk '{print $1}')"
if [ -n "${LAN_IP:-}" ]; then
  sed -i.bak "s|^EXPO_PUBLIC_API_URL=.*|EXPO_PUBLIC_API_URL=http://${LAN_IP}:3200|" .env && rm -f .env.bak
  ok "EXPO_PUBLIC_API_URL → http://${LAN_IP}:3200 (reachable from your phone)"
  # Trust the LAN origin too: a native fetch sends no Origin header, but Expo's
  # web target does, and it would be rejected as an untrusted origin.
  if grep -q '^TRUSTED_ORIGINS=$' .env; then
    sed -i.bak "s|^TRUSTED_ORIGINS=$|TRUSTED_ORIGINS=http://${LAN_IP}:3200,http://${LAN_IP}:8092|" .env && rm -f .env.bak
    ok "TRUSTED_ORIGINS → the LAN origins used for phone testing"
  fi
else
  warn "could not detect a LAN IP; set EXPO_PUBLIC_API_URL by hand for phone testing"
fi

bold "3/5  dependencies"
npm install --no-audit --fund=false
ok "installed"

bold "4/5  postgres + redis"
docker compose up -d db redis
printf '  waiting for health'
for _ in $(seq 1 60); do
  DB_STATE="$(docker inspect -f '{{.State.Health.Status}}' app-db 2>/dev/null || echo starting)"
  REDIS_STATE="$(docker inspect -f '{{.State.Health.Status}}' app-redis 2>/dev/null || echo starting)"
  if [ "$DB_STATE" = healthy ] && [ "$REDIS_STATE" = healthy ]; then break; fi
  printf '.'; sleep 1
done
printf '\n'
[ "${DB_STATE:-}" = healthy ] || die "postgres did not become healthy — check: docker compose logs db"
[ "${REDIS_STATE:-}" = healthy ] || die "redis did not become healthy — check: docker compose logs redis"
ok "postgres :5442 and redis :6389 healthy"

bold "5/5  database schema"
npm run db:deploy
ok "migrations applied"

cat <<'EOF'

  Ready. Next:

    make dev        web on http://localhost:3200 + the background worker
    make mobile     Expo dev server — scan the QR code with Expo Go
    make smoke      boot a production build and drive the real user journey
    make test       unit tests

  Sign up with any email and an 8+ character password; Google sign-in appears
  once you set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env.

EOF
