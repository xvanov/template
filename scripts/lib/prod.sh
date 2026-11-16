# shellcheck shell=bash
# Shared by scripts/deploy.sh, backup.sh and restore.sh. Sourced, not run.
#
# Two env files, on purpose:
#   .env.production  the APP's settings. Handed to web/worker/migrate via
#                    compose `env_file` only — never sourced by these scripts.
#   .env.deploy      OPS settings: POSTGRES_PASSWORD, PROD_WEB_PORT,
#                    DEPLOY_*, BACKUP_*, COMPOSE_PROFILES, CLOUDFLARE_TUNNEL_TOKEN.
#                    Sourced here and used for compose interpolation; never put
#                    into an app container, so a compromised web process does
#                    not hold the tunnel token or the backup target.
# Template: .env.deploy.example. Everything below is overridable from the
# environment, which is how the tests point these scripts at a throwaway stack:
#   ENV_FILE        app env file                  (default: .env.production)
#   DEPLOY_ENV_FILE ops env file                  (default: .env.deploy)
#   DEPLOY_PROJECT  compose project name          (default: <dir name>-prod)
#   DEPLOY_STATE    state dir: tags, lock, logs   (default: .deploy)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

ENV_FILE="${ENV_FILE:-.env.production}"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-.env.deploy}"
[ -f "$ENV_FILE" ] || {
  echo "✗ $ENV_FILE not found — copy .env.example to it and fill it in (docs/deploy.md)." >&2
  exit 1
}
[ -f "$DEPLOY_ENV_FILE" ] || {
  echo "✗ $DEPLOY_ENV_FILE not found — copy .env.deploy.example to it (docs/deploy.md)." >&2
  exit 1
}
# ORDER IS LOAD-BEARING (same trap as smoke.sh): `set -a` exports every key, so
# anything we must override is assigned AFTER this line.
set -a
# shellcheck disable=SC1090
. "$DEPLOY_ENV_FILE"
set +a
# Absolute from here on: compose resolves a relative path against the compose
# file's directory, and the scripts may be run from anywhere.
abspath() { echo "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; }
ENV_FILE="$(abspath "$ENV_FILE")"
DEPLOY_ENV_FILE="$(abspath "$DEPLOY_ENV_FILE")"
export ENV_FILE DEPLOY_ENV_FILE

# Pinned so a backup or restore never pulls a different image mid-incident.
export ALPINE_IMAGE="alpine:3.24.3"

# The project name scopes containers, volumes AND image names. A copied dev
# .env may carry COMPOSE_PROJECT_NAME for the dev stack, so it is replaced
# here, after sourcing, never inherited.
DEPLOY_PROJECT="${DEPLOY_PROJECT:-$(basename "$ROOT")-prod}"
export COMPOSE_PROJECT_NAME="$DEPLOY_PROJECT"

STATE_DIR="${DEPLOY_STATE:-$ROOT/.deploy}"
STATE_FILE="$STATE_DIR/state" # CURRENT=<tag> PREVIOUS=<tag> FAILED=<tag>
mkdir -p "$STATE_DIR"

compose() {
  docker compose -p "$DEPLOY_PROJECT" -f "$ROOT/docker-compose.prod.yml" \
    --env-file "$DEPLOY_ENV_FILE" "$@"
}

log() { echo "[$(date '+%F %T')] $*"; }
die() {
  echo "[$(date '+%F %T')] ✗ $*" >&2
  exit 1
}

state_get() { # state_get KEY → value or empty
  [ -f "$STATE_FILE" ] && sed -n "s/^$1=//p" "$STATE_FILE" | tail -1
  return 0
}
state_set() { # state_set KEY VALUE (atomic rewrite)
  local tmp="$STATE_FILE.tmp"
  { [ -f "$STATE_FILE" ] && grep -v "^$1=" "$STATE_FILE"; echo "$1=$2"; } >"$tmp" || true
  mv "$tmp" "$STATE_FILE"
}

db_running() { [ -n "$(compose ps -q --status running db 2>/dev/null)" ]; }
