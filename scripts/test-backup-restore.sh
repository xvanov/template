#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Proves backup.sh and restore.sh round-trip, against a throwaway Postgres
# started from docker-compose.prod.yml itself (its own project, no published
# ports, so it cannot touch the dev stack or production). ~15s.
#
#   scripts/test-backup-restore.sh      (make test-ops; CI's `ops` job)
#
# Data + an uploaded file → backup → destroy both → restore → same data, same
# file. Also: retention keeps N, keep counts < 2 are refused, dumps are
# owner-only, a restore without --yes off a terminal refuses, a restore leaves
# a pre-restore dump behind — and restoring the OLDEST pre-restore dump works
# even though the safety backup's retention would prune exactly that file.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ops-test.XXXXXX")"
DEPLOY_PROJECT="opstest-$(printf '%s' "$ROOT" | cksum | cut -d' ' -f1)"
export DEPLOY_PROJECT
export ENV_FILE="$TMP/app.env" DEPLOY_ENV_FILE="$TMP/deploy.env"
export DEPLOY_STATE="$TMP/state" BACKUP_DIR="$TMP/backups"
export COMPOSE_PROJECT_NAME="$DEPLOY_PROJECT"
: >"$ENV_FILE"
cat >"$DEPLOY_ENV_FILE" <<EOF
POSTGRES_PASSWORD=opstest-$RANDOM
BACKUP_KEEP_DAILY=2
BACKUP_KEEP_PRE=2
BACKUP_MIN_FREE_MB=1
EOF
ALPINE=alpine:3.24.3

compose() { docker compose -p "$DEPLOY_PROJECT" -f "$ROOT/docker-compose.prod.yml" --env-file "$DEPLOY_ENV_FILE" "$@"; }
sql() { compose exec -T db psql -U postgres -d app -tAq -v ON_ERROR_STOP=1 -c "$1"; }
upload() { docker run --rm -v "${DEPLOY_PROJECT}_storage:/s" "$ALPINE" sh -c "$1"; }
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
# pgvector (document search): the extension, a vector column and its HNSW
# index must survive the round trip — restore.sh recreates the database empty.
sql "CREATE EXTENSION IF NOT EXISTS vector; CREATE TABLE emb (id int PRIMARY KEY, e vector(3)); INSERT INTO emb VALUES (1, '[1,0,0]'), (2, '[0,1,0]'); CREATE INDEX emb_hnsw ON emb USING hnsw (e vector_cosine_ops);"
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
[ "$(sql "SELECT id FROM emb ORDER BY e <=> '[0.9,0.1,0]' LIMIT 1")" = 1 ] ||
  fail "vector rows did not come back (pgvector)"
[ "$(sql "SELECT to_regclass('emb_hnsw') IS NOT NULL")" = t ] || fail "the HNSW index did not come back"
[ "$(sql "SELECT to_regclass('junk') IS NULL")" = t ] || fail "a table created after the dump survived the restore"
[ "$(upload 'cat /s/org1/a.txt; ls /s')" = "$(printf 'hello\norg1')" ] || fail "uploads did not come back exactly"
ls "$BACKUP_DIR"/pre-restore/db-*.dump >/dev/null 2>&1 || fail "no pre-restore safety dump"

# The bug this guards against: with BACKUP_KEEP_PRE=2 and two pre-restore
# dumps on disk, restoring the OLDER one made its own safety backup prune that
# very file before pg_restore read it — dropping the database for nothing.
echo "→ restore the OLDEST pre-restore dump while pre-restore is at its keep limit"
sleep 1
"$ROOT/scripts/restore.sh" "$dump" --yes >/dev/null # adds a 2nd pre-restore dump
mapfile -t pre < <(ls -1tr "$BACKUP_DIR"/pre-restore/db-*.dump)
[ "${#pre[@]}" = 2 ] || fail "expected 2 pre-restore dumps, found ${#pre[@]}"
oldest="${pre[0]}" # taken by the first restore: the DAMAGED state (junk, no t)
sleep 1
"$ROOT/scripts/restore.sh" "$oldest" --yes >/dev/null ||
  fail "restoring the oldest pre-restore dump failed"
[ -f "$oldest" ] || fail "the safety backup pruned the dump being restored"
[ "$(sql "SELECT to_regclass('junk') IS NOT NULL AND to_regclass('t') IS NULL")" = t ] ||
  fail "the oldest pre-restore dump's data did not come back"


# A dump whose table of contents is intact (so it passes the pre-check) but
# whose data is cut short fails AFTER the database was dropped. restore.sh must
# say so and print an undo command that actually works.
echo "→ a restore that fails partway prints a working undo command"
before="$(sql "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
big="$TMP/big.dump"
sql "CREATE TABLE filler AS SELECT g, md5(g::text) AS h FROM generate_series(1, 20000) g;"
compose exec -T db pg_dump -U postgres -d app -Fc -Z 0 >"$big"
sql "DROP TABLE filler;"
head -c "$(($(stat -c %s "$big") * 3 / 4))" "$big" >"$TMP/truncated.dump"
if out="$("$ROOT/scripts/restore.sh" "$TMP/truncated.dump" --yes 2>&1)"; then
  fail "a truncated dump restored without error"
fi
undo_cmd="$(sed -n 's/^ *undo with: scripts\/restore.sh //p' <<<"$out")"
[ -n "$undo_cmd" ] || fail "no undo command printed: $out"
# shellcheck disable=SC2086 # the printed command is "<path> --yes"
"$ROOT/scripts/restore.sh" $undo_cmd >/dev/null || fail "the printed undo command failed"
[ "$(sql "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = "$before" ] ||
  fail "the undo did not bring the previous tables back"

echo "→ retention: 3 more daily backups with BACKUP_KEEP_DAILY=2"
for _ in 1 2 3; do
  sleep 1 # stamps have one-second resolution
  "$ROOT/scripts/backup.sh" --kind daily >/dev/null
done
n="$(find "$BACKUP_DIR/daily" -name 'db-*.dump' | wc -l)"
[ "$n" = 2 ] || fail "retention kept $n daily dumps, expected 2"

echo "→ keep counts below 2 are refused"
if BACKUP_KEEP_WEEKLY=1 "$ROOT/scripts/backup.sh" --kind weekly >/dev/null 2>&1; then
  fail "BACKUP_KEEP_WEEKLY=1 was accepted"
fi

echo "→ dumps are owner-only"
mode="$(stat -c %a "$(find "$BACKUP_DIR/daily" -name 'db-*.dump' | head -1)")"
[ "$mode" = 600 ] || fail "dump mode is $mode, expected 600"
