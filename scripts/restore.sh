#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Restore the production database from a backup.sh dump. Runbook:
# docs/deploy.md.
#
#   scripts/restore.sh latest                 newest dump of any kind
#   scripts/restore.sh backups/daily/db-20261116-031700.dump
#   scripts/restore.sh <dump> --with-storage  also restore the uploads tarball
#                                             written alongside it
#   scripts/restore.sh <dump> --yes           no prompt (scripts, tests)
#
# What it does, in order: checks the dump is a readable archive → asks you to
# confirm → backs up the CURRENT database first (--kind pre-restore, so a
# restore is itself undoable) → stops web + worker → drops and recreates the
# database → restores in ONE transaction (any error = empty db, nothing half
# restored; the pre-restore dump puts it back) → runs the live image's
# migrations, so an older dump is brought up to the schema the running code
# expects → starts web + worker again.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail
# shellcheck source=scripts/lib/prod.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/prod.sh"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"

dump="" yes=0 with_storage=0
for arg in "$@"; do
  case "$arg" in
    --yes | -y) yes=1 ;;
    --with-storage) with_storage=1 ;;
    -*) die "unknown option $arg" ;;
    *) dump="$arg" ;;
  esac
done
[ -n "$dump" ] || die "usage: $0 <dump-file|latest> [--yes] [--with-storage]"
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

cat <<EOF
About to REPLACE the database of project '$DEPLOY_PROJECT' with:
  $dump   ($(du -h "$dump" | cut -f1), written $(date -r "$dump" '+%F %T'))
$([ "$with_storage" = 1 ] && echo "  and the uploads volume with $tarball")
Everything written since that dump is lost (a pre-restore backup is taken first).
EOF
if [ "$yes" != 1 ]; then
  [ -t 0 ] || die "not a terminal — pass --yes to restore non-interactively"
  read -r -p "Type 'restore' to continue: " answer
  [ "$answer" = restore ] || die "aborted — nothing changed"
fi

log "safety backup of the current database"
"$ROOT/scripts/backup.sh" --kind pre-restore || die "pre-restore backup failed — not restoring"

running="$(compose ps -q --status running web worker 2>/dev/null || true)"
log "stopping web + worker"
compose stop web worker >/dev/null 2>&1 || true

log "recreating the database"
compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
  -c 'DROP DATABASE IF EXISTS app WITH (FORCE)' -c 'CREATE DATABASE app'

log "restoring $dump"
compose exec -T db pg_restore -U postgres -d app --no-owner --single-transaction \
  --exit-on-error <"$dump"

if [ "$with_storage" = 1 ]; then
  log "restoring uploads from $tarball"
  docker run --rm -i -v "${DEPLOY_PROJECT}_storage:/s" alpine:3 \
    sh -c 'find /s -mindepth 1 -delete && tar -xzf - -C /s' <"$tarball"
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
