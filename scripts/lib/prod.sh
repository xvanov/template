# shellcheck shell=bash
# Shared by scripts/deploy.sh, backup.sh and restore.sh. Sourced, not run.
#
# Everything is overridable from the environment, which is how the tests point
# these scripts at a throwaway stack:
#   ENV_FILE        production env file           (default: .env.production)
#   DEPLOY_PROJECT  compose project name          (default: <dir name>-prod)
#   DEPLOY_STATE    state dir: tags, lock, logs   (default: .deploy)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

ENV_FILE="${ENV_FILE:-.env.production}"
if [ ! -f "$ENV_FILE" ]; then
  echo "✗ $ENV_FILE not found — copy .env.example to it and fill it in (docs/deploy.md)." >&2
  exit 1
fi
# Read the env file for the BACKUP_*/DEPLOY_* settings it may hold. ORDER IS
# LOAD-BEARING (same trap as smoke.sh): sourcing with `set -a` exports every
# key, so anything we must override is assigned AFTER this line. Quote values
# containing < > | & in the file — `.` is a shell, not dotenv.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
# Absolute from here on: compose resolves a relative path against the compose
# file's directory, and the scripts may be run from anywhere.
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
export ENV_FILE

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
    --env-file "$ENV_FILE" "$@"
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
