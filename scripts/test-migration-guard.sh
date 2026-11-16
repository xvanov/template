#!/usr/bin/env bash
# Unit test for scripts/lib/migration-guard.sh: builds a throwaway git repo
# with Prisma-shaped migrations and checks which ones are flagged. <1s, no
# docker. Run by `make test-ops` and CI's `ops` job.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/migration-guard.sh
. "$ROOT/scripts/lib/migration-guard.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/guard-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
git init -q
g() { git -c user.email=t@t -c user.name=t "$@"; }
M="$MIGRATIONS_DIR"
add() { # add <name> <sql>  → commits a migration, prints the commit
  mkdir -p "$M/$1"
  printf '%s\n' "$2" >"$M/$1/migration.sql"
  g add -A && g commit -qm "$1" && git rev-parse HEAD
}
fails=0
expect() { # expect safe|destructive <from> <to> <label>
  local out rc=0
  out="$(destructive_migrations "$2" "$3")" || rc=$?
  if { [ "$1" = safe ] && [ "$rc" = 0 ]; } || { [ "$1" = destructive ] && [ "$rc" = 1 ] && [ -n "$out" ]; }; then
    echo "  ok   $4"
  else
    echo "  FAIL $4 (expected $1, rc=$rc, output: $out)"
    fails=$((fails + 1))
  fi
}

base="$(add 0_init 'CREATE TABLE "item" ("id" TEXT NOT NULL, "name" TEXT NOT NULL);')"
safe="$(add 1_add_column '-- AlterTable
ALTER TABLE "item" ADD COLUMN "note" TEXT;
CREATE INDEX "item_note_idx" ON "item"("note");
DROP INDEX "old_idx";')"
expect safe "$base" "$safe" "additive column + index, DROP INDEX allowed"

# shellcheck disable=SC2016 # literal SQL: the backticks are Prisma's, not ours
warned="$(add 2_comment_only '/*
  Warnings:
  - You are about to drop the column `x` on the `item` table. DROP COLUMN in a comment.
*/
-- DROP TABLE "item"; (commented out)
ALTER TABLE "item" ADD COLUMN "y" INTEGER;')"
expect safe "$safe" "$warned" "destructive words inside comments are ignored"

for case in \
  'drop_column|ALTER TABLE "item" DROP COLUMN "note";' \
  'drop_table|DROP TABLE "item";' \
  'rename_column|ALTER TABLE "item" RENAME COLUMN "name" TO "title";' \
  'rename_table|ALTER TABLE "item" RENAME TO "thing";' \
  'change_type|ALTER TABLE "item" ALTER COLUMN "y" SET DATA TYPE BIGINT;' \
  'set_not_null|ALTER TABLE "item" ALTER COLUMN "note" SET NOT NULL;'; do
  head="$(git rev-parse HEAD)"
  to="$(add "3_${case%%|*}" "${case#*|}")"
  expect destructive "$head" "$to" "${case%%|*} is flagged"
  g reset -q --hard "$head"
done

# Only migrations ADDED in the range count: an old destructive one is history.
old="$(add 4_old_drop 'ALTER TABLE "item" DROP COLUMN "y";')"
later="$(add 5_add 'ALTER TABLE "item" ADD COLUMN "z" TEXT;')"
expect safe "$old" "$later" "a destructive migration from an earlier deploy is not re-flagged"
expect destructive "$warned" "$later" "a multi-migration range catches the destructive one"

[ "$fails" = 0 ] || {
  echo "✗ migration guard: $fails failing case(s)" >&2
  exit 1
}
echo "✓ migration guard"
