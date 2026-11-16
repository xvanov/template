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

# One migration per case: <expected>|<name>|<sql>. Deny by default — every
# DROP/RENAME/type change/TRUNCATE is flagged unless it is on the short list
# of statements that only relax the schema or touch indexes.
# shellcheck disable=SC2016 # literal SQL
for case in \
  'destructive|drop_column|ALTER TABLE "item" DROP COLUMN "note";' \
  'destructive|drop_bare_column|ALTER TABLE "item" DROP "note";' \
  'destructive|drop_if_exists|ALTER TABLE item DROP IF EXISTS note;' \
  'destructive|drop_table|DROP TABLE "item";' \
  'destructive|drop_view|DROP VIEW "item_view";' \
  'destructive|drop_type|DROP TYPE "Role";' \
  'destructive|drop_schema|DROP SCHEMA "legacy" CASCADE;' \
  'destructive|drop_lowercase|alter table item drop column note;' \
  'destructive|rename_column|ALTER TABLE "item" RENAME COLUMN "name" TO "title";' \
  'destructive|rename_bare|ALTER TABLE item RENAME note TO body;' \
  'destructive|rename_table|ALTER TABLE "item" RENAME TO "thing";' \
  'destructive|rename_enum_value|ALTER TYPE "Role" RENAME VALUE '"'"'A'"'"' TO '"'"'B'"'"';' \
  'destructive|set_data_type|ALTER TABLE "item" ALTER COLUMN "y" SET DATA TYPE BIGINT;' \
  'destructive|alter_type_short|ALTER TABLE item ALTER y TYPE bigint;' \
  'destructive|set_not_null|ALTER TABLE "item" ALTER COLUMN "note" SET NOT NULL;' \
  'destructive|add_required_column|ALTER TABLE "item" ADD COLUMN "owner" TEXT NOT NULL;' \
  'destructive|add_required_second|ALTER TABLE "item" ADD COLUMN "a" TEXT, ADD COLUMN "b" INTEGER NOT NULL;' \
  'destructive|truncate|TRUNCATE "item";' \
  'destructive|multiline|ALTER TABLE "item"
     DROP
     COLUMN "note";' \
  'safe|drop_index|DROP INDEX "item_note_idx";' \
  'safe|drop_index_if_exists|DROP INDEX IF EXISTS "item_note_idx";' \
  'safe|drop_default|ALTER TABLE "item" ALTER COLUMN "note" DROP DEFAULT;' \
  'safe|drop_not_null|ALTER TABLE "item" ALTER COLUMN "note" DROP NOT NULL;' \
  'safe|drop_constraint|ALTER TABLE "item" DROP CONSTRAINT "item_owner_fkey";' \
  'safe|rename_index|ALTER INDEX "item_a_idx" RENAME TO "item_b_idx";' \
  'safe|rename_constraint|ALTER TABLE "thing" RENAME CONSTRAINT "item_pkey" TO "thing_pkey";' \
  'safe|add_required_with_default|ALTER TABLE "item" ADD COLUMN "n" INTEGER NOT NULL DEFAULT 0;' \
  'safe|add_foreign_key|ALTER TABLE "item" ADD CONSTRAINT "item_o_fkey" FOREIGN KEY ("o") REFERENCES "user"("id") ON DELETE CASCADE;' \
  'safe|create_table_not_null|CREATE TABLE "thing" ("id" TEXT NOT NULL, CONSTRAINT "thing_pkey" PRIMARY KEY ("id"));' \
  'safe|create_enum|CREATE TYPE "Role" AS ENUM ('"'"'A'"'"', '"'"'B'"'"');' \
  'safe|enum_add_value|ALTER TYPE "Role" ADD VALUE '"'"'C'"'"';' \
  'safe|identifiers_named_like_keywords|ALTER TABLE "drop" ADD COLUMN "type" TEXT, ADD COLUMN "rename" TEXT;' \
  'safe|keyword_in_string_literal|ALTER TABLE "item" ADD COLUMN "s" TEXT DEFAULT '"'"'DROP TABLE x'"'"';'; do
  want="${case%%|*}"
  rest="${case#*|}"
  name="${rest%%|*}"
  head="$(git rev-parse HEAD)"
  to="$(add "3_$name" "${rest#*|}")"
  expect "$want" "$head" "$to" "$name is $want"
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
