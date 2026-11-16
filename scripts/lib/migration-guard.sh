# shellcheck shell=bash
# Sourced by scripts/deploy.sh; unit-tested by scripts/test-migration-guard.sh.
#
# A rollback swaps code, not schema: the previous image must keep working on
# the schema the new deploy migrated to. So a migration that removes or
# reshapes something the old code reads (drop a column/table, rename, change a
# type, add NOT NULL) breaks rollback — and if the deploy fails, the automatic
# rollback lands on a schema the old code cannot use. deploy.sh refuses such a
# migration unless --allow-destructive. The safe way is expand/contract: add
# the new shape and ship code that uses it; remove the old shape in a LATER
# deploy, once nothing will roll back to code that needs it (docs/deploy.md).

MIGRATIONS_DIR="${MIGRATIONS_DIR:-packages/db/prisma/migrations}"

# Statements that make the previous release's code fail against the new schema.
DESTRUCTIVE_SQL='DROP[[:space:]]+(COLUMN|TABLE)|RENAME[[:space:]]+(COLUMN|TO|CONSTRAINT)|ALTER[[:space:]]+COLUMN[^;]*[[:space:]]TYPE[[:space:]]|SET[[:space:]]+NOT[[:space:]]+NULL'

# destructive_migrations <from-commit> <to-commit>
# Prints "<file>: <statement>" for every destructive statement in migration
# files ADDED between the two commits (run inside the git checkout). Comments
# are ignored — Prisma writes "You are about to drop the column…" warnings in
# them. Returns 1 if it found any, 0 if none.
destructive_migrations() {
  # Decided on the OUTPUT, not a pipeline's exit status: that would depend on
  # whether the caller set pipefail.
  local from="$1" to="$2" file hits found=0
  while IFS= read -r file; do
    case "$file" in *.sql) ;; *) continue ;; esac
    hits="$(git show "$to:$file" |
      sed -e 's/--.*$//' | tr '\n' ' ' | sed -e 's#/\*[^*]*\*\+\([^/*][^*]*\*\+\)*/##g' | tr ';' '\n' |
      grep -iE "$DESTRUCTIVE_SQL" | sed -e 's/^[[:space:]]*//' || true)"
    if [ -n "$hits" ]; then
      printf '%s\n' "$hits" | sed "s#^#$file: #"
      found=1
    fi
  done < <(git diff --name-only --diff-filter=A "$from" "$to" -- "$MIGRATIONS_DIR")
  [ "$found" = 0 ]
}
