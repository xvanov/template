#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Proves backup.sh and restore.sh round-trip, against a throwaway Postgres
# started from docker-compose.prod.yml itself (its own project, no published
# ports, so it cannot touch the dev stack or production). ~15s.
#
#   scripts/test-backup-restore.sh      (make test-ops; CI's `ops` job)
#
# Data + an uploaded file → backup → destroy both → restore → same data, same
# file. Also: retention keeps N, a restore without --yes off a terminal
# refuses, and a restore leaves a pre-restore dump behind.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ops-test.XXXXXX")"
DEPLOY_PROJECT="opstest-$(printf '%s' "$ROOT" | cksum | cut -d' ' -f1)"
export DEPLOY_PROJECT
export ENV_FILE="$TMP/env" DEPLOY_STATE="$TMP/state" BACKUP_DIR="$TMP/backups"
export COMPOSE_PROJECT_NAME="$DEPLOY_PROJECT"
cat >"$ENV_FILE" <<EOF
POSTGRES_PASSWORD=opstest-$RANDOM
BACKUP_KEEP_DAILY=2
BACKUP_MIN_FREE_MB=1
EOF

compose() { docker compose -p "$DEPLOY_PROJECT" -f "$ROOT/docker-compose.prod.yml" --env-file "$ENV_FILE" "$@"; }
sql() { compose exec -T db psql -U postgres -d app -tAq -v ON_ERROR_STOP=1 -c "$1"; }
upload() { docker run --rm -v "${DEPLOY_PROJECT}_storage:/s" alpine:3 sh -c "$1"; }
fail() {
  echo "✗ $*" >&2
  exit 1
}
cleanup() {
  local code=$?
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume rm -f "${DEPLOY_PROJECT}_storage" >/dev/null 2>&1 || true
  rm -rf "$TMP"
  [ "$code" = 0 ] && echo "✓ backup → restore round trip (${SECONDS}s)"
  exit "$code"
}
trap cleanup EXIT

echo "→ throwaway postgres ($DEPLOY_PROJECT)"
compose up -d --wait db >/dev/null 2>&1

sql "CREATE TABLE t (id int PRIMARY KEY, note text); INSERT INTO t VALUES (1, 'før'), (2, 'after');"
upload 'mkdir -p /s/org1 && echo hello > /s/org1/a.txt'

echo "→ backup"
"$ROOT/scripts/backup.sh" --kind daily
dump="$(ls "$BACKUP_DIR"/daily/db-*.dump)"
[ -f "$BACKUP_DIR/daily/storage-$(basename "$dump" .dump | sed 's/^db-//').tar.gz" ] ||
  fail "no uploads archive next to the dump"

echo "→ damage: drop the table, add a stray one, delete the upload"
sql "DROP TABLE t; CREATE TABLE junk (x int);"
upload 'rm -rf /s/org1 && echo stray > /s/stray.txt'

echo "→ restore without --yes off a terminal must refuse"
if "$ROOT/scripts/restore.sh" "$dump" </dev/null >/dev/null 2>&1; then
  fail "restore ran without confirmation"
fi
[ "$(sql "SELECT to_regclass('junk') IS NOT NULL")" = t ] || fail "the refused restore changed the database"

echo "→ restore"
"$ROOT/scripts/restore.sh" "$dump" --yes --with-storage

[ "$(sql "SELECT string_agg(id || ':' || note, ',' ORDER BY id) FROM t")" = "1:før,2:after" ] ||
  fail "rows did not come back"
[ "$(sql "SELECT to_regclass('junk') IS NULL")" = t ] || fail "a table created after the dump survived the restore"
[ "$(upload 'cat /s/org1/a.txt; ls /s')" = "$(printf 'hello\norg1')" ] || fail "uploads did not come back exactly"
ls "$BACKUP_DIR"/pre-restore/db-*.dump >/dev/null 2>&1 || fail "no pre-restore safety dump"

echo "→ retention: 3 more daily backups with BACKUP_KEEP_DAILY=2"
for _ in 1 2 3; do
  sleep 1 # stamps have one-second resolution
  "$ROOT/scripts/backup.sh" --kind daily >/dev/null
done
n="$(find "$BACKUP_DIR/daily" -name 'db-*.dump' | wc -l)"
[ "$n" = 2 ] || fail "retention kept $n daily dumps, expected 2"
