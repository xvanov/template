#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Back up the production database (and local-disk uploads). Runbook:
# docs/deploy.md. Nightly via ops/systemd/backup.timer; deploy.sh also runs it
# with --kind pre-deploy before every migration.
#
#   scripts/backup.sh                      daily (weekly on Sundays)
#   scripts/backup.sh --kind pre-deploy    kept separately, newest 5
#
# Writes $BACKUP_DIR/<kind>/db-<stamp>.dump — pg_dump custom format, which is
# compressed and is what restore.sh reads — plus storage-<stamp>.tar.gz when
# the uploads volume is non-empty. Retention: 7 daily, 4 weekly, 5 pre-deploy.
# Old copies are pruned BEFORE writing, and it refuses to start if the disk
# would drop under BACKUP_MIN_FREE_MB: a backup must never be the write that
# fills the disk and takes the app down with it.
#
# Off-host copy (optional): BACKUP_RSYNC_TARGET=user@host:/path pushes the new
# files there over ssh (key auth; BatchMode, so it never hangs on a prompt).
# A failed push fails the run, so the timer shows it, but the local copy stays.
#
# BACKUP_PROTECT=<file> (set by restore.sh): never prune that dump or its
# uploads tarball. Without it, a restore from the OLDEST pre-restore dump had
# its own safety backup prune the very file it was about to restore.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail
# Dumps hold password hashes, sessions and sealed secrets: owner-only files.
umask 077
# shellcheck source=scripts/lib/prod.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/prod.sh"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-2048}"

kind=""
while [ $# -gt 0 ]; do
  case "$1" in
    --kind)
      kind="${2:-}"
      shift 2
      ;;
    *) die "usage: $0 [--kind daily|weekly|pre-deploy|pre-restore]" ;;
  esac
done
if [ -z "$kind" ]; then
  case "$(date +%u)" in 7) kind=weekly ;; *) kind=daily ;; esac
fi
case "$kind" in
  daily) keep="${BACKUP_KEEP_DAILY:-7}" ;;
  weekly) keep="${BACKUP_KEEP_WEEKLY:-4}" ;;
  pre-deploy | pre-restore) keep="${BACKUP_KEEP_PRE:-5}" ;;
  *) die "unknown --kind $kind" ;;
esac
# keep=1 would prune the only previous copy before the new one is proven good.
if ! [[ "$keep" =~ ^[0-9]+$ ]] || [ "$keep" -lt 2 ]; then
  die "keep count for $kind must be >= 2 (got '$keep')"
fi

db_running || die "the database container is not running (project $DEPLOY_PROJECT)"

dest="$BACKUP_DIR/$kind"
mkdir -p "$dest"
stamp="$(date +%Y%m%d-%H%M%S)"
dump="$dest/db-$stamp.dump"
tarball="$dest/storage-$stamp.tar.gz"

# Never leave a half-written file: retention keeps "the newest N", so a partial
# dump would quietly push a good one out.
trap 'rm -f "$dump.partial" "$tarball.partial"' EXIT

# 1. prune first, so the space they held is available to this run.
# Keep keep-1 old ones: with the one about to be written that makes `keep`.
protect=""
if [ -n "${BACKUP_PROTECT:-}" ]; then
  protect="$(realpath -m "$BACKUP_PROTECT")"
  protect_tar="$(dirname "$protect")/storage-$(basename "$protect" .dump | sed 's/^db-//').tar.gz"
fi
prune() { # prune <glob>
  local f
  # $1 is a glob on purpose; the names are ours (no spaces or newlines).
  # shellcheck disable=SC2012,SC2086
  ls -1t "$dest"/$1 2>/dev/null | tail -n +"$keep" | while read -r f; do
    f="$(realpath -m "$f")"
    if [ -n "$protect" ] && { [ "$f" = "$protect" ] || [ "$f" = "$protect_tar" ]; }; then
      continue
    fi
    rm -f -- "$f"
  done || true
}
prune 'db-*.dump'
prune 'storage-*.tar.gz'

# 2. room check: the newest existing dump (+25%) plus the uploads volume's
# size (an upper bound for its tarball), plus a floor.
# shellcheck disable=SC2012
last="$(ls -1t "$BACKUP_DIR"/*/db-*.dump 2>/dev/null | head -1 || true)"
last_kb=0
[ -z "$last" ] || last_kb="$(du -k "$last" | cut -f1)"
vol="${DEPLOY_PROJECT}_storage"
uploads_kb=0
if docker volume inspect "$vol" >/dev/null 2>&1; then
  uploads_kb="$(docker run --rm -v "$vol:/s:ro" "$ALPINE_IMAGE" du -sk /s | cut -f1)"
fi
need_kb=$(((last_kb * 5 / 4) + uploads_kb + MIN_FREE_MB * 1024))
avail_kb="$(df -Pk "$dest" | awk 'NR==2 {print $4}')"
[ "$avail_kb" -ge "$need_kb" ] ||
  die "only $((avail_kb / 1024))MB free in $dest, need $((need_kb / 1024))MB — not backing up"

# 3. dump, then prove the file is a readable archive before keeping it.
log "dumping → $dump"
compose exec -T db pg_dump -U postgres -d app -Fc -Z 6 >"$dump.partial"
compose exec -T db pg_restore --list <"$dump.partial" >/dev/null ||
  die "the dump is not a valid archive — discarded"
mv "$dump.partial" "$dump"
files=("$dump")

# 4. uploads, when STORAGE_DRIVER=local put any in the volume (S3 is its own
# backup story). Read-only mount from a throwaway container.
if docker volume inspect "$vol" >/dev/null 2>&1 &&
  [ -n "$(docker run --rm -v "$vol:/s:ro" "$ALPINE_IMAGE" ls -A /s)" ]; then
  log "archiving uploads → $tarball"
  docker run --rm -v "$vol:/s:ro" "$ALPINE_IMAGE" tar -czf - -C /s . >"$tarball.partial"
  gzip -t "$tarball.partial" || die "the uploads archive is corrupt — discarded"
  mv "$tarball.partial" "$tarball"
  files+=("$tarball")
fi

log "✓ $(du -h "$dump" | cut -f1) $dump"

# 5. off-host copy.
if [ -n "${BACKUP_RSYNC_TARGET:-}" ]; then
  log "copying to $BACKUP_RSYNC_TARGET/$kind/"
  rsync -a --mkpath -e "ssh -o BatchMode=yes -o ConnectTimeout=15" \
    "${files[@]}" "$BACKUP_RSYNC_TARGET/$kind/" ||
    die "off-host copy failed (the local backup is fine: $dump)"
fi
