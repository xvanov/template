# shellcheck shell=bash
# Sourced by scripts/deploy.sh; unit-tested by scripts/test-migration-guard.sh.
#
# A rollback swaps code, not schema: the previous image must keep working on
# the schema the new deploy migrated to. So a migration that removes or
# reshapes something the old code reads or writes breaks rollback — and if the
# deploy fails, the AUTOMATIC rollback lands on a schema the old code cannot
# use. deploy.sh refuses such a migration unless --allow-destructive. The safe
# way is expand/contract: add the new shape and ship code that uses it; remove
# the old shape in a LATER deploy, once nothing will roll back to code that
# needs it (docs/deploy.md).
#
# DENY BY DEFAULT. Flagged, per statement:
#   * every DROP, except DROP INDEX / DROP DEFAULT / DROP NOT NULL /
#     DROP CONSTRAINT (they only relax the schema) — so DROP COLUMN, DROP "a",
#     DROP IF EXISTS a, DROP TABLE/VIEW/TYPE/SCHEMA… are all caught
#   * every RENAME, except ALTER INDEX … RENAME and ALTER TABLE … RENAME
#     CONSTRAINT (Prisma generates both, e.g. for a primary key after a model
#     rename; old code never names an index or a constraint, and false alarms
#     only teach people to reach for --allow-destructive)
#   * any type change inside ALTER TABLE (ALTER COLUMN a TYPE …, ALTER a TYPE
#     …, SET DATA TYPE …)
#   * SET NOT NULL, and ADD COLUMN … NOT NULL without a DEFAULT (Prisma's
#     output for a new required field: the old code's INSERTs omit the column
#     and fail)
#   * TRUNCATE
# Quoted identifiers and string literals are blanked before matching, so a
# column called "type" or "drop" cannot trip (or hide from) a rule.
#
# Known blind spot: comments are stripped textually, so `--` INSIDE a string
# literal (e.g. DEFAULT '--') cuts the rest of that line — and a destructive
# statement after it on the SAME line would be missed. Prisma never writes
# that; review hand-written SQL that does.

MIGRATIONS_DIR="${MIGRATIONS_DIR:-packages/db/prisma/migrations}"

# Reads SQL statements, one per line; prints "<statement>   [<reason>]" for
# each destructive one.
_guard_classify() {
  # The single quote is passed in as q: \x27 escapes are gawk-only, and the
  # system awk may be mawk.
  awk -v q="'" '
    {
      s = $0; gsub(/[[:space:]]+/, " ", s); sub(/^ /, "", s); sub(/ $/, "", s)
      if (s == "") next
      u = toupper(s)
      gsub(q "[^" q "]*" q, q q, u)              # string literals -> empty
      gsub(/"[^"]*"/, "\"X\"", u)                # quoted identifiers -> "X"
      u = " " u " "
      why = ""

      if (u ~ /^ TRUNCATE /) why = "TRUNCATE"

      t = u
      while (why == "" && match(t, / DROP /)) {
        t = substr(t, RSTART + RLENGTH - 1)
        if (t !~ /^ (INDEX|DEFAULT|NOT NULL|CONSTRAINT) /) why = "DROP"
        t = substr(t, 2)
      }

      if (why == "" && u ~ / RENAME / && u !~ /^ ALTER INDEX / && u !~ / RENAME CONSTRAINT /) why = "RENAME"
      if (why == "" && u ~ /^ ALTER TABLE / && u ~ / TYPE /) why = "type change"
      if (why == "" && u ~ / SET NOT NULL /) why = "SET NOT NULL"

      if (why == "" && u ~ /^ ALTER TABLE /) {
        # one clause per element: ALTER TABLE t ADD COLUMN a …, ADD COLUMN b …
        n = split(u, part, / ADD /)
        for (i = 2; i <= n; i++) {
          if (part[i] ~ /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE) /) continue
          if (part[i] ~ / NOT NULL/ && part[i] !~ / DEFAULT / && part[i] !~ / GENERATED /) {
            why = "ADD COLUMN NOT NULL without DEFAULT"; break
          }
        }
      }

      if (why != "") print s "   [" why "]"
    }'
}

# destructive_migrations <from-commit> <to-commit>
# Prints "<file>: <statement>   [<reason>]" for every destructive statement in
# migration files ADDED between the two commits (run inside the git
# checkout). Comments are ignored — Prisma writes "You are about to drop the
# column…" warnings in them. Returns 1 if it found any, 0 if none.
destructive_migrations() {
  # Decided on the OUTPUT, not a pipeline's exit status: that would depend on
  # whether the caller set pipefail.
  local from="$1" to="$2" file hits found=0
  while IFS= read -r file; do
    case "$file" in *.sql) ;; *) continue ;; esac
    hits="$(git show "$to:$file" |
      sed -e 's/--.*$//' | tr '\n' ' ' | sed -e 's#/\*[^*]*\*\+\([^/*][^*]*\*\+\)*/##g' | tr ';' '\n' |
      _guard_classify || true)"
    if [ -n "$hits" ]; then
      printf '%s\n' "$hits" | sed "s#^#$file: #"
      found=1
    fi
  done < <(git diff --name-only --diff-filter=A "$from" "$to" -- "$MIGRATIONS_DIR")
  [ "$found" = 0 ]
}
