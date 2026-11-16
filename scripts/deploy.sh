#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Production deploy for one Docker host. Runbook: docs/deploy.md.
#
#   scripts/deploy.sh [deploy] [--force] [--no-pull] [--detach]
#   scripts/deploy.sh rollback      back to the previous image tags
#   scripts/deploy.sh status        tags, containers, health
#
# deploy: fast-forward the checkout (never merges, never forces) → build images
# tagged with the commit (the old containers keep serving meanwhile) → back up
# the database → run migrations → PREFLIGHT: boot the new web image beside the
# live one, with no port and no traffic, until /api/health passes → replace
# web + worker → wait for health and the worker's "up" line → on failure, put
# the previous tags back and wait for THEM to be healthy. Two deploys never
# overlap (flock).
#
# Not blue/green, on purpose. The swap itself measured ~0.3s of refused
# connections; preflight means a build that cannot boot or answer health never
# takes traffic at all. Blue/green would need a proxy, two app copies and
# several hundred lines more to remove that last 0.3s.
#
# Migrations run FORWARD only. A rollback swaps code, not schema, so the old
# code must run on the new schema — write additive migrations (add, backfill,
# drop in a LATER deploy). The pre-deploy dump is there for when that fails.
#
# Triggered from a systemd service (a webhook listener, an agent, a timer)?
# Use --detach: it re-runs this script in its own transient unit, so the deploy
# survives that service being stopped or restarted. `setsid nohup` does NOT do
# this — it leaves the process in the caller's cgroup, and stopping the caller
# kills the deploy halfway.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail
# shellcheck source=scripts/lib/prod.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/prod.sh"

BRANCH="${DEPLOY_BRANCH:-main}"
HEALTH_TIMEOUT="${DEPLOY_HEALTH_TIMEOUT:-120}" # seconds for web to report healthy
KEEP_IMAGES="${DEPLOY_KEEP_IMAGES:-3}"         # tags kept per image, beyond current+previous
APP_SERVICES=(web worker)

usage() { sed -n '3,8p' "$0" | sed 's/^# \{0,1\}//'; }

# ── health ───────────────────────────────────────────────────────────────
container_of() { compose ps -q "$1" 2>/dev/null | head -1; }

# Healthy = Docker's healthcheck (which calls /api/health) says so. A container
# that exits or restart-loops fails fast instead of waiting out the timeout.
wait_healthy() { # wait_healthy <container>
  local status deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ $SECONDS -lt $deadline ]; do
    status="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$1" 2>/dev/null || echo gone)"
    case "$status" in
      "running healthy") return 0 ;;
      exited* | dead* | restarting* | gone)
        log "web container is $status"
        return 1
        ;;
    esac
    sleep 1
  done
  log "web not healthy after ${HEALTH_TIMEOUT}s"
  return 1
}
wait_web() { wait_healthy "$(container_of web)"; }

# Boot the new web image next to the live one: `compose run` publishes no
# port and joins no service alias, so nothing routes to it. If it cannot get
# healthy here, the live containers are never touched.
preflight() { # preflight <tag>
  local name="$DEPLOY_PROJECT-preflight" ok=0
  docker rm -f "$name" >/dev/null 2>&1 || true
  APP_TAG="$1" compose run -d --no-deps --name "$name" web >/dev/null
  wait_healthy "$name" && ok=1
  if [ "$ok" = 0 ]; then
    echo "── last 40 lines of the new web ──" >&2
    docker logs --tail 40 "$name" >&2 2>&1 || true
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  [ "$ok" = 1 ]
}

# The worker has no HTTP port; it prints "[worker] up" once it is consuming.
# Checked on the NEW container, and it must still be running (not restarting).
wait_worker() {
  local id deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ $SECONDS -lt $deadline ]; do
    id="$(container_of worker)"
    if [ -n "$id" ]; then
      if [ "$(docker inspect -f '{{.RestartCount}}' "$id")" != 0 ]; then
        log "worker restarted (crashed on boot)"
        return 1
      fi
      # Not `docker logs | grep -q`: under pipefail, grep exiting early makes
      # docker logs die of SIGPIPE and the pipeline "fails" after a match.
      grep -q '\[worker\] up' <<<"$(docker logs "$id" 2>&1)" && return 0
    fi
    sleep 1
  done
  log "worker never logged '[worker] up' within ${HEALTH_TIMEOUT}s"
  return 1
}

healthy() { wait_web && wait_worker; }

show_failure_logs() {
  local s
  for s in "${APP_SERVICES[@]}"; do
    echo "── last 40 lines of $s ──" >&2
    compose logs --no-log-prefix --tail 40 "$s" >&2 || true
  done
}

# Replace web + worker with the images tagged $1 and wait for them.
run_tag() {
  APP_TAG="$1" compose up -d --no-deps --no-build "${APP_SERVICES[@]}" && healthy
}

# Anything else in an active profile (cloudflared with COMPOSE_PROFILES=tunnel).
start_extras() {
  local extras
  mapfile -t extras < <(compose config --services | grep -vxE 'db|redis|migrate|web|worker' || true)
  [ ${#extras[@]} -eq 0 ] || compose up -d --no-deps "${extras[@]}"
}

# Keep current + previous + the newest $KEEP_IMAGES other tags of each image.
prune_images() {
  local svc keep cur prev
  cur="$(state_get CURRENT)"
  prev="$(state_get PREVIOUS)"
  for svc in web worker migrate; do
    keep=0
    docker images "$DEPLOY_PROJECT-$svc" --format '{{.Tag}}' | while read -r tag; do
      [ "$tag" = "$cur" ] || [ "$tag" = "$prev" ] && continue
      keep=$((keep + 1))
      if [ "$keep" -gt "$KEEP_IMAGES" ]; then
        docker rmi "$DEPLOY_PROJECT-$svc:$tag" >/dev/null 2>&1 || true
      fi
    done
  done
  docker image prune -f >/dev/null 2>&1 || true
}

# ── git: fast-forward only ───────────────────────────────────────────────
update_checkout() {
  [ -z "$(git status --porcelain --untracked-files=no)" ] ||
    die "the checkout has uncommitted changes — deploys build what is committed"
  local on
  on="$(git rev-parse --abbrev-ref HEAD)"
  [ "$on" = "$BRANCH" ] || die "checkout is on '$on', not '$BRANCH' (set DEPLOY_BRANCH to change)"
  git fetch --quiet origin "$BRANCH" || die "git fetch failed"
  git merge-base --is-ancestor HEAD "origin/$BRANCH" ||
    die "local $BRANCH has commits origin does not — reconcile by hand, never force"
  git merge --ff-only --quiet "origin/$BRANCH"
}

# ── commands ─────────────────────────────────────────────────────────────
cmd_deploy() {
  local force=0 pull=1 arg
  for arg in "$@"; do
    case "$arg" in
      --force) force=1 ;;
      --no-pull) pull=0 ;;
      *) die "unknown option $arg" ;;
    esac
  done

  [ "$pull" = 1 ] && update_checkout
  [ -z "$(git status --porcelain --untracked-files=no)" ] ||
    die "the checkout has uncommitted changes — deploys build what is committed"
  local tag cur
  tag="$(git rev-parse --short=12 HEAD)"
  cur="$(state_get CURRENT)"

  if [ "$force" = 0 ] && [ "$tag" = "$cur" ] && [ -n "$(container_of web)" ]; then
    log "already running $tag — nothing to do (--force to redeploy)"
    return 0
  fi
  if [ "$force" = 0 ] && [ "$tag" = "$(state_get FAILED)" ]; then
    die "$tag failed its last deploy and was rolled back; push a fix, or --force to retry"
  fi

  log "deploying $tag ($(git log -1 --format=%s)) — live: ${cur:-nothing}"
  log "building images (the live version keeps serving)"
  APP_TAG="$tag" compose build web worker migrate

  log "database + redis"
  compose up -d --wait db redis

  if [ -n "$cur" ]; then
    log "pre-deploy backup"
    "$ROOT/scripts/backup.sh" --kind pre-deploy ||
      die "pre-deploy backup failed — not deploying (live version untouched)"
  fi

  log "migrations"
  if ! APP_TAG="$tag" compose run --rm --no-deps migrate; then
    state_set FAILED "$tag"
    die "migration failed — web and worker NOT replaced; $cur is still live"
  fi

  log "preflight: booting $tag beside the live version"
  if ! preflight "$tag"; then
    state_set FAILED "$tag"
    die "$tag never got healthy in preflight — nothing replaced; ${cur:-nothing} is still live"
  fi

  log "replacing web + worker"
  if run_tag "$tag"; then
    [ -n "$cur" ] && [ "$cur" != "$tag" ] && state_set PREVIOUS "$cur"
    state_set CURRENT "$tag"
    state_set FAILED ""
    start_extras
    prune_images
    log "✓ deployed $tag — healthy"
    return 0
  fi

  show_failure_logs
  state_set FAILED "$tag"
  if [ -z "$cur" ]; then
    die "first deploy of $tag is unhealthy, and there is nothing to roll back to"
  fi
  log "↩ rolling back to $cur"
  if run_tag "$cur"; then
    die "$tag was unhealthy; rolled back — $cur is live and healthy"
  fi
  show_failure_logs
  die "$tag was unhealthy AND the rollback to $cur is unhealthy too — look now"
}

cmd_rollback() {
  local cur prev
  cur="$(state_get CURRENT)"
  prev="$(state_get PREVIOUS)"
  [ -n "$prev" ] || die "no previous tag recorded — nothing to roll back to"
  log "rolling back $cur → $prev (code only; the schema stays as migrated)"
  if run_tag "$prev"; then
    state_set CURRENT "$prev"
    state_set PREVIOUS "$cur"
    log "✓ $prev is live and healthy"
  else
    show_failure_logs
    die "$prev is unhealthy — put $cur back with: scripts/deploy.sh rollback"
  fi
}

cmd_status() {
  echo "project:  $DEPLOY_PROJECT    env: $ENV_FILE"
  echo "current:  $(state_get CURRENT)"
  echo "previous: $(state_get PREVIOUS)"
  local failed
  failed="$(state_get FAILED)"
  [ -z "$failed" ] || echo "failed:   $failed (not live; skipped until a new commit or --force)"
  echo
  compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
  echo
  local url="http://127.0.0.1:${PROD_WEB_PORT:-3280}/api/health"
  echo "GET $url → $(curl -s --max-time 5 "$url" || echo unreachable)"
}

# ── main ─────────────────────────────────────────────────────────────────
# Flags alone mean deploy: `deploy.sh --force` = `deploy.sh deploy --force`.
cmd=deploy
case "${1:-}" in
  -h | --help) cmd=help ;;
  "" | -*) ;;
  *)
    cmd="$1"
    shift
    ;;
esac

if [ "$cmd" = deploy ] && [[ " $* " == *" --detach "* ]]; then
  args=()
  for a in "$@"; do [ "$a" = --detach ] || args+=("$a"); done
  mode=(--user)
  [ "$(id -u)" = 0 ] && mode=()
  unit="${DEPLOY_PROJECT}-deploy-$(date +%s)"
  systemd-run "${mode[@]}" --unit="$unit" --collect --same-dir \
    --property=StandardOutput="append:$STATE_DIR/deploy.log" \
    --property=StandardError="append:$STATE_DIR/deploy.log" \
    --setenv=ENV_FILE="$ENV_FILE" --setenv=DEPLOY_PROJECT="$DEPLOY_PROJECT" \
    --setenv=DEPLOY_STATE="$STATE_DIR" --setenv=PATH="$PATH" \
    "$ROOT/scripts/deploy.sh" deploy "${args[@]}"
  echo "started unit $unit — follow with: tail -f $STATE_DIR/deploy.log"
  exit 0
fi

case "$cmd" in
  deploy | rollback)
    # One at a time. A second deploy WAITS rather than failing, so a burst of
    # merges deploys in order instead of dropping all but the first.
    exec 9>"$STATE_DIR/lock"
    if ! flock -n 9; then
      log "another deploy is running — waiting for it"
      flock 9
    fi
    "cmd_$cmd" "$@"
    ;;
  status) cmd_status ;;
  help) usage ;;
  *)
    usage
    exit 2
    ;;
esac
