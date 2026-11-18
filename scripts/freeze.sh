#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Pre-submission snapshot: prove the commit works, write down exactly what is
# being submitted, and tag it.
#
#   ./scripts/freeze.sh [--url https://demo.example.com] [--tag NAME] [--skip-gates]
#   (make freeze)
#
# 1. Refuses a dirty tree (uncommitted or untracked files): what gets tagged
#    must be what was tested.
# 2. Runs the gates on it, uncached: typecheck, lint, every test
#    (turbo --force), smoke; plus ml/'s ruff + pytest when ml/ and uv exist.
#    Logs: logs/freeze-<gate>.log. The first failure stops everything.
# 3. Writes SUBMISSION.md: the commit the gates ran on, the URL, how to run
#    it, gate results and timings, and sha256 of the ML artifacts that are not
#    in git (model, split, config), so "which model did we submit?" has an
#    answer next week.
# 4. Commits SUBMISSION.md and puts an annotated tag (default
#    submission-<UTC yyyymmdd-hhmm>) on that commit. Pushes nothing: it
#    prints the push command.
#
# --skip-gates is for a deadline emergency only; SUBMISSION.md then says, in
# bold, that the gates did not run.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
bold() { printf '\033[1m%s\033[0m\n' "$1"; }

URL=""
TAG="submission-$(date -u +%Y%m%d-%H%M)"
SKIP_GATES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:?--url needs a value}"; shift 2 ;;
    --tag) TAG="${2:?--tag needs a value}"; shift 2 ;;
    --skip-gates) SKIP_GATES=1; shift ;;
    -h | --help) sed -n '2,25p' "$0"; exit 0 ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
done

git rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository"
git check-ref-format "refs/tags/$TAG" || die "not a valid tag name: $TAG"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then die "tag $TAG already exists"; fi
if [ -n "$(git status --porcelain)" ]; then
  git status --short >&2
  die "the tree is dirty: commit or stash first (what gets tagged must be what was tested)"
fi
COMMIT="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
REMOTE="$(git remote get-url origin 2>/dev/null || echo "(no origin remote)")"
if [ -z "$URL" ] && [ -f .env ]; then
  URL="$(sed -n 's/^APP_URL=//p' .env | tr -d '"' | head -1)"
fi

mkdir -p logs
GATE_ROWS=""
run_gate() { # name, command...
  local name=$1 log start secs
  shift
  log="logs/freeze-${name// /-}.log"
  printf '  %-12s ' "$name"
  start=$SECONDS
  if "$@" >"$log" 2>&1; then
    secs=$((SECONDS - start))
    printf '\033[32mpass\033[0m (%ss)\n' "$secs"
    GATE_ROWS+="| $name | pass | ${secs}s | \`$*\` |"$'\n'
  else
    printf '\033[31mFAIL\033[0m\n'
    tail -40 "$log" >&2
    die "gate \"$name\" failed (full log: $log). Nothing was tagged."
  fi
}

if [ "$SKIP_GATES" = 1 ]; then
  bold "gates SKIPPED (--skip-gates)"
  GATE_ROWS="| **all** | **SKIPPED (--skip-gates)** | | |"$'\n'
else
  bold "gates on $SHORT (uncached)"
  # --force everywhere: a replayed turbo cache entry proves nothing about this tree.
  run_gate typecheck npx turbo run typecheck --force
  run_gate lint bash -c "npx turbo run lint --force && make lint-sh"
  run_gate test npx turbo run test --force
  run_gate smoke make smoke
  if [ -d ml ] && command -v uv >/dev/null; then
    run_gate "ml lint" bash -c "cd ml && uv run --frozen ruff check && uv run --frozen ruff format --check"
    run_gate "ml test" bash -c "cd ml && uv run --frozen pytest"
  elif [ -d ml ]; then
    GATE_ROWS+="| ml | not run (uv not installed) | | |"$'\n'
  fi
fi

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }
ML_ROWS=""
if [ -f ml/runs/LATEST ]; then
  run_id="$(tr -d '[:space:]' <ml/runs/LATEST)"
  for f in model.json metrics.json config.json; do
    p="ml/runs/$run_id/$f"
    if [ -f "$p" ]; then ML_ROWS+="| \`$p\` | \`$(sha "$p")\` |"$'\n'; fi
  done
fi
for p in ml/splits/*.json; do
  if [ -f "$p" ]; then ML_ROWS+="| \`$p\` (in git) | \`$(sha "$p")\` |"$'\n'; fi
done

{
  echo "# Submission"
  echo
  echo "Written by \`scripts/freeze.sh\` on $(date -u '+%Y-%m-%d %H:%M UTC'). Do not edit by hand; run it again."
  echo
  echo "| | |"
  echo "|---|---|"
  echo "| Code commit (gates ran on this) | \`$COMMIT\` |"
  echo "| Branch | \`$BRANCH\` |"
  echo "| Tag | \`$TAG\` (on the commit that adds this file) |"
  echo "| Repository | $REMOTE |"
  echo "| Demo URL | ${URL:-(none given: --url)} |"
  echo
  echo "## How to run it"
  echo
  echo '```bash'
  echo "git clone $REMOTE app && cd app && git checkout $TAG"
  echo "make demo        # infra, migrations, demo data, web + worker; prints the URL and login"
  echo "make doctor      # if anything is missing, this says what"
  echo '```'
  echo
  echo "Needs Node 22+ and Docker. The demo login is printed by \`make demo\` (default demo@example.com / demo-password)."
  echo
  echo "## Gates"
  echo
  echo "| Gate | Result | Time | Command |"
  echo "|---|---|---|---|"
  printf '%s' "$GATE_ROWS"
  if [ -n "$ML_ROWS" ]; then
    echo
    echo "## ML artifacts"
    echo
    echo "Model files are not in git (ml/runs/ is ignored). These hashes say which ones were submitted."
    echo
    echo "| File | sha256 |"
    echo "|---|---|"
    printf '%s' "$ML_ROWS"
    best="$(sed -n '/^## Current best/,/^## /p' ml/experiments/REGISTRY.md 2>/dev/null | grep '^| [^-M]' | head -3 || true)"
    if [ -n "$best" ]; then
      echo
      echo "Current best (ml/experiments/REGISTRY.md):"
      echo
      echo "| Metric | Value | Experiment | Run |"
      echo "|---|---|---|---|"
      echo "$best"
    fi
  fi
} >SUBMISSION.md

git add SUBMISSION.md
git commit -q -m "submission: freeze $TAG at $SHORT" -- SUBMISSION.md
git tag -a "$TAG" -m "Submission snapshot. Gates ran on $COMMIT."
bold "frozen: $TAG -> $(git rev-parse --short HEAD) (SUBMISSION.md), code $SHORT"
echo "  push it:  git push origin HEAD && git push origin $TAG"
