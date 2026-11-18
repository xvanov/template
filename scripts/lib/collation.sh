# shellcheck shell=bash
# ──────────────────────────────────────────────────────────────────────────
# Detect and repair databases whose text sort order changed under them.
#
# Why: with the libc collation provider, Postgres sorts text with the C
# library of the IMAGE. Reopen a data directory under another libc —
# postgres:17-alpine (musl) → a Debian (glibc) image, or a glibc major
# upgrade — and every index on a text column is in the OLD order. Nothing
# errors: lookups silently miss rows that exist, and UNIQUE indexes admit
# duplicates (reproduced: 360 of 2000 emails findable, 2646 of 3000 duplicate
# inserts accepted). Once a duplicate is in, the rebuild that would have fixed
# it fails.
#
# Detection: pg_database.datcollversion (recorded at creation) vs what the
# library reports now. The repair itself is packages/db/prisma/ops/
# collation-guard.sql — the SAME file the `migrate` service runs before every
# migration, so a host whose deploy script predates this check is still
# protected by the new image. Per database: every user index rebuilt and the
# new version recorded, in one transaction. One query when nothing changed.
#
#   collation_mismatched <psql-fn>   print the databases that need a rebuild
#   collation_repair <psql-fn>       rebuild them; non-zero (and a loud
#                                    explanation) if one cannot be rebuilt —
#                                    the caller must NOT start the app then
#
# <psql-fn> runs psql as a superuser against the server: it gets psql
# arguments (-d <db> ...) and SQL on stdin.
#
# Run directly (`bash scripts/lib/collation.sh`) it checks the DEV stack
# (docker compose in the repo root): `make up` and setup.sh do that.
# ──────────────────────────────────────────────────────────────────────────

COLLATION_GUARD_SQL="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/packages/db/prisma/ops/collation-guard.sql"

collation_mismatched() { # collation_mismatched <psql-fn>
  "$1" -d postgres -tAq -v ON_ERROR_STOP=1 <<'SQL'
SELECT datname FROM pg_database
WHERE datallowconn
  AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid)
ORDER BY datname;
SQL
}

collation_repair() { # collation_repair <psql-fn>
  local psql="$1" dbs db
  dbs="$(collation_mismatched "$psql")" || {
    echo "✗ collation check: could not query the database server" >&2
    return 1
  }
  [ -n "$dbs" ] || return 0

  while IFS= read -r db; do
    [ -n "$db" ] || continue
    echo "→ the text sort order (collation) of database \"$db\" changed under it — rebuilding its indexes"
    if ! "$psql" -d "$db" -q -v ON_ERROR_STOP=1 <"$COLLATION_GUARD_SQL"; then
      cat >&2 <<EOF

✗ Rebuilding the indexes of database "$db" FAILED, and nothing was changed.
  The error above says why. Most often: a unique index already holds rows
  that are duplicates once sorted correctly (written while the indexes were
  stale) — the error then names the index and the duplicated key. This needs
  a person; the app must stay stopped.

  Find every duplicate with (fill in the table and the index's columns):

    SELECT <columns>, count(*), array_agg(ctid)
    FROM <table> GROUP BY <columns> HAVING count(*) > 1;

  Merge or delete the extra rows, then run the check again (deploy.sh,
  make up, or bash scripts/lib/collation.sh). Restoring the last dump taken
  before the image change is the other way out (docs/guide.md, "collation").
EOF
      return 1
    fi
    echo "✓ database \"$db\": indexes rebuilt, collation version recorded"
  done <<<"$dbs"
}

# ── direct use: the dev stack ────────────────────────────────────────────
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  _dev_psql() { docker compose exec -T db psql -U postgres "$@"; }
  collation_repair _dev_psql
fi
