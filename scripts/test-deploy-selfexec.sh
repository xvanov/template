#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Proves deploy.sh hands over to the NEW commit's deploy.sh after pulling
# (~1s, no docker). Why it matters: an older deploy.sh that pulled a release
# changing the deploy steps (the collation check) ran its OLD steps on the
# new commit and recreated the database under the live app.
#
# A scratch origin + checkout of this repo's scripts. The origin then gets a
# commit whose deploy.sh is a stub that records how it was started. Running
# the current deploy.sh must: fast-forward, then exec the stub with
# `deploy --no-pull` plus the original flags, still holding the deploy lock.
#
#   scripts/test-deploy-selfexec.sh      (make test-ops; CI's `ops` job)
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/selfexec-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() {
  echo "✗ $*" >&2
  exit 1
}
g() { git -c user.email=t@example.test -c user.name=test -c init.defaultBranch=main "$@"; }

g init -q --bare "$TMP/origin.git"
g clone -q "$TMP/origin.git" "$TMP/work" 2>/dev/null
mkdir -p "$TMP/work/scripts/lib"
cp "$ROOT/scripts/deploy.sh" "$TMP/work/scripts/"
cp "$ROOT"/scripts/lib/*.sh "$TMP/work/scripts/lib/"
mkdir -p "$TMP/work/packages/db/prisma/ops"
printf '.env.*\n.deploy/\n' >"$TMP/work/.gitignore"
(cd "$TMP/work" && g add -A && g commit -qm old && g push -q origin HEAD:main)

# The host's checkout, on the OLD commit.
g clone -q "$TMP/origin.git" "$TMP/host"
: >"$TMP/host/.env.production"
echo "POSTGRES_PASSWORD=x" >"$TMP/host/.env.deploy"

# The new release: its deploy.sh reports how it was invoked.
cat >"$TMP/work/scripts/deploy.sh" <<'STUB'
#!/usr/bin/env bash
{
  echo "args=$*"
  echo "lock_held=${DEPLOY_LOCK_HELD:-}"
  [ -e /proc/$$/fd/9 ] && echo "fd9=open" || echo "fd9=closed"
  # A second process must NOT get the deploy lock while this one runs.
  if flock -n "$(dirname "$0")/../.deploy/lock" true; then echo "lock=free"; else echo "lock=held"; fi
} >"$(dirname "$0")/../.deploy/stub-ran"
STUB
(cd "$TMP/work" && g commit -qam new && g push -q origin HEAD:main)

cd "$TMP/host"
out="$(DEPLOY_PROJECT=selfexec-test bash scripts/deploy.sh deploy --force 2>&1)" ||
  fail "deploy.sh failed: $out"
grep -q "continuing with its deploy.sh" <<<"$out" || fail "no hand-over logged: $out"
[ -f .deploy/stub-ran ] || fail "the new deploy.sh never ran: $out"
grep -qx "args=deploy --no-pull --force" .deploy/stub-ran || fail "wrong args: $(cat .deploy/stub-ran)"
grep -qx "lock_held=1" .deploy/stub-ran || fail "lock not marked held"
grep -qx "lock=held" .deploy/stub-ran || fail "the deploy lock was released across the re-exec: another deploy could start"
if [ -d /proc/self/fd ]; then
  grep -qx "fd9=open" .deploy/stub-ran || fail "the deploy lock fd was not inherited"
fi
[ "$(git rev-parse HEAD)" = "$(git -C "$TMP/work" rev-parse HEAD)" ] || fail "checkout did not fast-forward"
echo "✓ deploy.sh re-execs the pulled deploy.sh, keeping its flags and the lock"
