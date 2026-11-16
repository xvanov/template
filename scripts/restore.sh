#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Restore the production database from a backup.sh dump. Runbook:
# docs/deploy.md.
#
#   scripts/restore.sh latest                 newest dump of any kind
#   scripts/restore.sh backups/daily/db-20261116-031700.dump
#   scripts/restore.sh <dump> --with-storage  also restore the uploads tarball
#                                             written alongside it
#   scripts/restore.sh <dump> --flush-redis   also empty the job queue (below)
#   scripts/restore.sh <dump> --yes           no prompt (scripts, tests)
#   scripts/restore.sh <dump> --skip-safety-backup
#                       for when the current db cannot be dumped (disk full,
#                       corrupt). ALWAYS asks for typed confirmation, --yes or
#                       not: without the safety dump the restore is one-way.
#
# What it does, in order: checks the dump is a readable archive and holds it
# open → asks you to confirm → backs up the CURRENT database first (--kind
# pre-restore, so a restore is itself undoable; the dump being restored is
# protected from that backup's retention) → stops web + worker → drops and
# recreates the database → restores in ONE transaction → runs the live
# image's migrations, so an older dump is brought up to the schema the running
# code expects → starts web + worker again. If anything fails after web +
# worker were stopped, it prints the exact command that puts the old data back.
#
# Redis is NOT restored. Jobs queued before the restore may name rows the
# restored database does not have (they fail, and are recorded in job_run);
# --flush-redis drops every queued, delayed and scheduled job instead. The
# worker re-registers its cron schedules when it starts.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail
umask 077
# shellcheck source=scripts/lib/prod.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/prod.sh"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"

dump="" yes=0 with_storage=0 skip_safety=0 flush_redis=0
for arg in "$@"; do
  case "$arg" in
    --yes | -y) yes=1 ;;
    --with-storage) with_storage=1 ;;
    --skip-safety-backup) skip_safety=1 ;;
    --flush-redis) flush_redis=1 ;;
    -*) die "unknown option $arg" ;;
    *) dump="$arg" ;;
  esac
done
[ -n "$dump" ] || die "usage: $0 <dump-file|latest> [--yes] [--with-storage] [--flush-redis] [--skip-safety-backup]"
if [ "$dump" = latest ]; then
  # shellcheck disable=SC2012
  dump="$(ls -1t "$BACKUP_DIR"/*/db-*.dump 2>/dev/null | head -1 || true)"
  [ -n "$dump" ] || die "no dumps in $BACKUP_DIR"
fi
[ -f "$dump" ] || die "no such file: $dump"
tarball="${dump%/*}/storage-$(basename "$dump" .dump | sed 's/^db-//').tar.gz"
if [ "$with_storage" = 1 ] && [ ! -f "$tarball" ]; then
  die "--with-storage: no uploads archive next to the dump ($tarball)"
fi

db_running || die "the database container is not running — start it: scripts/deploy.sh, or compose up -d db"
compose exec -T db pg_restore --list <"$dump" >/dev/null || die "$dump is not a valid pg_dump archive"
# Hold the files open from here on: even if something deletes them (retention
# in the safety backup below once did exactly that), we still read them.
exec 3<"$dump"
[ "$with_storage" = 0 ] || exec 4<"$tarball"

echo "About to REPLACE the database of project '$DEPLOY_PROJECT' with:"
echo "  $dump   ($(du -h "$dump" | cut -f1), written $(date -r "$dump" '+%F %T'))"
[ "$with_storage" = 0 ] || echo "  and the uploads volume with $tarball"
[ "$flush_redis" = 0 ] || echo "  and EMPTY the Redis job queue"
echo "Everything written since that dump is lost."
if [ "$skip_safety" = 1 ]; then
  echo "NO safety backup will be taken (--skip-safety-backup): the current data is gone for good."
  [ -t 0 ] || die "--skip-safety-backup needs a terminal: it always asks, even with --yes"
  read -r -p "Type 'restore without backup' to continue: " answer
  [ "$answer" = "restore without backup" ] || die "aborted — nothing changed"
elif [ "$yes" != 1 ]; then
  echo "A pre-restore backup of the current data is taken first."
  [ -t 0 ] || die "not a terminal — pass --yes to restore non-interactively"
  read -r -p "Type 'restore' to continue: " answer
  [ "$answer" = restore ] || die "aborted — nothing changed"
fi

undo="no safety backup was taken (--skip-safety-backup)"
if [ "$skip_safety" = 0 ]; then
  log "safety backup of the current database"
  BACKUP_PROTECT="$dump" "$ROOT/scripts/backup.sh" --kind pre-restore ||
    die "pre-restore backup failed — not restoring (--skip-safety-backup if the db cannot be dumped)"
  # shellcheck disable=SC2012
  safety="$(ls -1t "$BACKUP_DIR"/pre-restore/db-*.dump | head -1)"
  undo="undo with: scripts/restore.sh $safety --yes"
  [ "$with_storage" = 0 ] || undo="$undo --with-storage"
fi

running="$(compose ps -q --status running web worker 2>/dev/null || true)"
log "stopping web + worker"
compose stop web worker >/dev/null 2>&1 || true
on_exit() {
  local code=$?
  if [ "$code" != 0 ]; then
    echo >&2
    echo "✗ restore FAILED partway. web + worker are STOPPED and the database may be empty." >&2
    echo "  $undo" >&2
  fi
  exit "$code"
}
trap on_exit EXIT

log "recreating the database"
compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
  -c 'DROP DATABASE IF EXISTS app WITH (FORCE)' -c 'CREATE DATABASE app'

log "restoring $dump"
compose exec -T db pg_restore -U postgres -d app --no-owner --single-transaction \
  --exit-on-error <&3

if [ "$with_storage" = 1 ]; then
  log "restoring uploads from $tarball"
  docker run --rm -i -v "${DEPLOY_PROJECT}_storage:/s" "$ALPINE_IMAGE" \
    sh -c 'find /s -mindepth 1 -delete && tar -xzf - -C /s' <&4
fi

if [ "$flush_redis" = 1 ]; then
  log "emptying the Redis job queue"
  compose up -d --wait redis >/dev/null 2>&1
  compose exec -T redis redis-cli FLUSHALL >/dev/null
fi

tag="$(state_get CURRENT)"
if [ -n "$tag" ]; then
  log "migrations of the live image ($tag)"
  APP_TAG="$tag" compose run --rm --no-deps migrate
  if [ -n "$running" ]; then
    log "starting web + worker"
    APP_TAG="$tag" compose up -d --no-deps --wait --wait-timeout 120 web worker
  fi
fi
log "✓ restored $dump"
