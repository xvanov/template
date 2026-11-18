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
  # A relative STORAGE_LOCAL_DIR resolves against each process's cwd, and the
  # web app (apps/web) and the worker (apps/worker) run from different ones: an
  # upload would land where the worker never looks. A NEW .env gets one
  # absolute directory. Quoted for the shell readers; `\ & |` escaped for sed.
  STORAGE_DIR_SED="$(printf '%s' "${ROOT}/storage" | sed 's/[\\&|]/\\&/g')"
  sed -i.bak "s|^STORAGE_LOCAL_DIR=.*|STORAGE_LOCAL_DIR=\"${STORAGE_DIR_SED}\"|" .env && rm -f .env.bak
  ok "STORAGE_LOCAL_DIR → ${ROOT}/storage (shared by web and worker)"
fi

# An EXISTING .env is never rewritten (its uploads live where it points), but a
# relative storage path is worth one line of advice.
if grep -q '^STORAGE_LOCAL_DIR="\{0,1\}[^/"]' .env; then
  warn "STORAGE_LOCAL_DIR is relative, so web and worker use different folders. To share one: set STORAGE_LOCAL_DIR=\"${ROOT}/storage\" in .env and move apps/web/storage/* there."
fi

# @module:mobile
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
# @end

bold "3/5  dependencies"
npm install --no-audit --fund=false
ok "installed"

bold "4/5  postgres + redis + mail"
# `--wait` blocks until every healthcheck passes and exits non-zero if one never
# does, which replaces polling `docker inspect` by container name — names this
# stack deliberately no longer hardcodes.
docker compose up -d --wait db redis mailpit
# A db volume first created by another image (one with a different C library,
# e.g. Alpine vs Debian) sorts text differently: rebuild its indexes before anything
# reads them. A no-op otherwise. (scripts/lib/collation.sh)
bash scripts/lib/collation.sh
ok "postgres :${DB_PORT:-5442}, redis :${REDIS_PORT:-6389}, mail inbox http://localhost:${MAIL_UI_PORT:-8035}"

bold "5/5  database schema"
npm run db:deploy
ok "migrations applied"

cat <<'EOF'

  Ready. Next:

    make dev        web on http://localhost:3200 + the background worker
    make inbox      the local mail inbox (sign-up confirmation links land here)
EOF
# @module:mobile
echo "    make mobile     Expo dev server — scan the QR code with Expo Go"
# @end
cat <<'EOF'
    make smoke      boot a production build and drive the real user journey
    make test       unit tests

  Sign up with any email and an 8+ character password, then open the
  confirmation link from http://localhost:8035 — it signs you straight in.
  Google sign-in appears once GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are set.

EOF
