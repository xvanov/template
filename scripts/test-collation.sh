#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Proves scripts/lib/collation.sh against the real failure, not a mock (~15s):
#
#   1. A volume initialised by postgres:17-alpine (musl), with a UNIQUE index
#      on text — what every pre-pgvector install of this template has.
#   2. Reopened on a Debian (glibc) image. amcheck must flag the index as
#      corrupt, and the stale unique index must admit a duplicate: the
#      reproduction, so this test cannot pass vacuously.
#   3. collation_repair must REFUSE (duplicates are in), say so, and change
#      nothing (one transaction: the version stays unrecorded).
#   4. Remove the duplicates; collation_repair (packages/db/prisma/ops/
#      collation-guard.sql — what the migrate image runs too) must rebuild:
#      amcheck clean, a duplicate rejected again, the version recorded so a
#      second run is a no-op.
#
#   scripts/test-collation.sh      (make test-ops; CI's `ops` job)
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/collation.sh
. "$ROOT/scripts/lib/collation.sh"

OLD_IMAGE=postgres:17-alpine
# Any glibc image of the same major. The pgvector one is what this template
# moves to; pinned here so the test does not depend on the compose files.
NEW_IMAGE=pgvector/pgvector:0.8.6-pg17-bookworm
NAME="colltest-$(printf '%s' "$ROOT" | cksum | cut -d' ' -f1)"
VOL="$NAME-data"

fail() {
  echo "✗ $*" >&2
  exit 1
}
cleanup() {
  local code=$?
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOL" >/dev/null 2>&1 || true
  [ "$code" = 0 ] && echo "✓ collation change detected and repaired (${SECONDS}s)"
  exit "$code"
}
trap cleanup EXIT
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume rm -f "$VOL" >/dev/null 2>&1 || true

start() { # start <image>
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" -e POSTGRES_PASSWORD=x -e POSTGRES_DB=app \
    -v "$VOL:/var/lib/postgresql/data" "$1" >/dev/null

  for _ in $(seq 1 60); do
    docker exec "$NAME" pg_isready -U postgres -d app -q 2>/dev/null &&
      docker exec "$NAME" psql -U postgres -d app -tAqc 'SELECT 1' >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  docker logs "$NAME" >&2
  fail "$1 did not start"
}
psql_c() { docker exec -i "$NAME" psql -U postgres "$@"; }
sql() { psql_c -d app -tAq -v ON_ERROR_STOP=1 -c "$1"; }

# amcheck (heapallindexed) every btree index in app; prints NOTICE bad=<n>.
corrupt_indexes() {
  sql "CREATE EXTENSION IF NOT EXISTS amcheck" >/dev/null
  psql_c -d app -tAq <<'SQL'
DO $$ DECLARE r record; bad int := 0; BEGIN
  FOR r IN SELECT c.oid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_am a ON a.oid = c.relam JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE a.amname = 'btree' AND n.nspname = 'public' LOOP
    BEGIN PERFORM bt_index_check(r.oid, true);
    EXCEPTION WHEN others THEN bad := bad + 1; END;
  END LOOP;
  RAISE NOTICE 'bad=%', bad;
END $$;
SQL
}
bad_count() { corrupt_indexes 2>&1 | sed -n 's/.*bad=\([0-9]*\).*/\1/p'; }

echo "→ $OLD_IMAGE (musl): a table with a unique text index"
start "$OLD_IMAGE"
# Mixed case and punctuation: musl sorts by bytes, glibc's en_US does not.
sql "CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL UNIQUE);
     INSERT INTO users (email)
     SELECT (ARRAY['a','B','c.','D-','e_','F'])[1 + g % 6] || md5(g::text) || '@Ex-ample.com'
     FROM generate_series(1, 2000) g;" >/dev/null

echo "→ reopened on $NEW_IMAGE (glibc)"
start "$NEW_IMAGE"
[ "$(bad_count)" -gt 0 ] || fail "amcheck found no stale index — the reproduction did not reproduce"
dups="$(sql "INSERT INTO users (email) SELECT email FROM users ON CONFLICT DO NOTHING RETURNING 1" | wc -l)"
[ "$dups" -gt 0 ] || fail "the stale unique index rejected every duplicate — not reproduced"
echo "  stale: amcheck fails, and the unique index admitted $dups duplicate emails"

echo "→ collation_repair must refuse while duplicates are in"
if out="$(collation_repair psql_c 2>&1)"; then
  fail "collation_repair succeeded with duplicates in a unique index"
fi
grep -q 'indexes of database "app" FAILED' <<<"$out" || fail "no clear failure message: $out"
[ "$(sql "SELECT count(*) FROM pg_database WHERE datname = 'app' AND datcollversion IS NULL")" = 1 ] ||
  fail "a failed rebuild recorded the new collation version anyway"

echo "→ duplicates removed by hand; collation_repair rebuilds"
# Index scans off: the stale index must not decide what counts as a duplicate.
sql "SET enable_indexscan = off; SET enable_bitmapscan = off; SET enable_indexonlyscan = off;
     DELETE FROM users a USING users b WHERE a.email = b.email AND a.id > b.id" >/dev/null
out="$(collation_repair psql_c)"
grep -q 'database "app": indexes rebuilt' <<<"$out" || fail "app was not repaired: $out"
[ "$(bad_count)" = 0 ] || fail "indexes still corrupt after repair"
if sql "INSERT INTO users (email) SELECT email FROM users LIMIT 1" >/dev/null 2>&1; then
  fail "the repaired unique index admitted a duplicate"
fi
[ "$(sql "SELECT count(*) FROM pg_database WHERE datallowconn AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid)")" = 0 ] ||
  fail "collation version not recorded"
[ -z "$(collation_repair psql_c)" ] || fail "a second run was not a no-op"
