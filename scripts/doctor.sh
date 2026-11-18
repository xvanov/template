#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Is this machine ready? One line per check, then a verdict.
#
#   ./scripts/doctor.sh      (make doctor)
#
# PASS fine · INFO worth knowing · WARN something will not work until fixed ·
# FAIL nothing will work until fixed (exit code 1).
#
# Read-only and fast (a couple of seconds): it starts, installs and writes
# nothing. Each problem line says the command that fixes it.
# ──────────────────────────────────────────────────────────────────────────
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

FAILS=0
WARNS=0
if [ -t 1 ]; then G=$'\033[32m' Y=$'\033[33m' R=$'\033[31m' D=$'\033[2m' B=$'\033[1m' N=$'\033[0m'
else G="" Y="" R="" D="" B="" N=""; fi
pass() { printf '  %sPASS%s  %s\n' "$G" "$N" "$1"; }
info() { printf '  %sINFO%s  %s\n' "$D" "$N" "$1"; }
warn() { printf '  %sWARN%s  %s\n' "$Y" "$N" "$1"; WARNS=$((WARNS + 1)); }
fail() { printf '  %sFAIL%s  %s\n' "$R" "$N" "$1"; FAILS=$((FAILS + 1)); }
section() { printf '%s%s%s\n' "$B" "$1" "$N"; }

# `timeout` is GNU coreutils: macOS has it only as gtimeout (brew coreutils),
# or not at all. Without either, a background watchdog kills the command, so
# a hung `docker info` or an unreachable remote host never hangs the doctor.
if command -v timeout >/dev/null; then TIMEOUT=(timeout)
elif command -v gtimeout >/dev/null; then TIMEOUT=(gtimeout)
else TIMEOUT=(); fi
with_timeout() { # seconds cmd...
  local s=$1 pid watchdog rc
  shift
  if [ ${#TIMEOUT[@]} -gt 0 ]; then "${TIMEOUT[@]}" "$s" "$@"; return; fi
  "$@" &
  pid=$!
  (sleep "$s"; kill "$pid" 2>/dev/null) &
  watchdog=$!
  wait "$pid"
  rc=$?
  kill "$watchdog" 2>/dev/null
  return "$rc"
}
# true if something accepts TCP connections on host:port (1s timeout).
listening() { with_timeout 1 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }
# host and port of a URL: "postgresql://u:p@host:5442/db" -> "host 5442"
host_port() {
  if [[ "$1" =~ ^[a-z+]+://([^@/]*@)?([^:/?]+)(:([0-9]+))? ]]; then
    echo "${BASH_REMATCH[2]} ${BASH_REMATCH[4]:-$2}"
  fi
}

# ── tools ─────────────────────────────────────────────────────────────────
section "tools"
if command -v node >/dev/null; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -ge 22 ]; then pass "node $(node -v)"; else fail "node $(node -v): need >= 22 (nvm install 22)"; fi
else
  fail "node is not installed (>= 22: https://nodejs.org or nvm install 22)"
fi
if [ -x node_modules/.bin/turbo ]; then pass "dependencies installed"
else fail "node_modules missing: make setup (or npm install)"; fi
if command -v docker >/dev/null; then
  if with_timeout 10 docker info >/dev/null 2>&1; then
    if with_timeout 10 docker compose version >/dev/null 2>&1; then
      pass "docker $(docker --version | awk '{print $3}' | tr -d ,) + compose"
    else fail "docker compose (v2) is missing"; fi
  else fail "docker is installed but the daemon did not answer within 10s (start Docker / add yourself to the docker group)"; fi
else
  fail "docker is not installed (Postgres and Redis run in it)"
fi
if command -v shellcheck >/dev/null; then pass "shellcheck $(shellcheck --version | sed -n 's/^version: //p')"
else info "no shellcheck: make lint uses its docker image instead"; fi
if compgen -G "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}/chromium*" >/dev/null \
  || compgen -G "$HOME/Library/Caches/ms-playwright/chromium*" >/dev/null; then
  pass "playwright chromium (for make smoke)"
else
  warn "no playwright chromium: make smoke needs it (npx playwright install chromium --only-shell)"
fi

# ── .env ──────────────────────────────────────────────────────────────────
section ".env"
ENV_OK=0
if [ ! -f .env ]; then
  fail ".env missing: make setup (writes it with a generated secret)"
else
  # Sourced the way smoke.sh and deploy scripts read it: an unquoted < > | &
  # is a shell redirect there, even though dotenv would accept it.
  # shellcheck source=/dev/null  # per-machine file
  if src_err="$( (set -a; . ./.env) 2>&1 >/dev/null)" && [ -z "$src_err" ]; then
    set -a
    # shellcheck source=/dev/null
    . ./.env
    set +a
    ENV_OK=1
    pass ".env parses as shell"
  else
    fail ".env does not parse as shell (quote values containing < > | &): $(echo "$src_err" | head -1)"
  fi
fi
if [ "$ENV_OK" = 1 ]; then
  for key in DATABASE_URL REDIS_URL APP_URL; do
    if [ -n "${!key:-}" ]; then pass "$key set"; else fail "$key is empty"; fi
  done
  secret="${BETTER_AUTH_SECRET:-}"
  if [ "${#secret}" -lt 32 ] || [[ "$secret" == *change* ]] || [[ "$secret" == *replace* ]]; then
    fail "BETTER_AUTH_SECRET missing, short or a placeholder (openssl rand -base64 32)"
  else pass "BETTER_AUTH_SECRET set"; fi
  app_port="$(host_port "${APP_URL:-}" 80 | awk '{print $2}')"
  if [ -n "${WEB_PORT:-}" ] && [ -n "$app_port" ] && [ "$app_port" != "$WEB_PORT" ] \
    && [[ "${APP_URL:-}" == *localhost* || "${APP_URL:-}" == *127.0.0.1* ]]; then
    warn "APP_URL port $app_port != WEB_PORT $WEB_PORT: sign-in will say \"Invalid origin\""
  fi
  if [ "${LLM_ENABLED:-true}" = false ]; then info "AI: off (LLM_ENABLED=false); the app runs without it"
  elif [ -n "${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}${OPENROUTER_API_KEY:-}${AZURE_OPENAI_API_KEY:-}${DEEPSEEK_API_KEY:-}${LLM_API_KEY:-}" ]; then
    pass "AI: a provider key is set (models: ${LLM_MODEL_FAST:-${LLM_MODEL:-default}})"
  elif [[ "${LLM_MODEL:-}${LLM_MODEL_FAST:-}" == *cli/* ]] || [[ "${LLM_BASE_URL:-}" == *localhost* || "${LLM_BASE_URL:-}" == *127.0.0.1* ]]; then
    pass "AI: keyless provider (cli/ or a local server at ${LLM_BASE_URL:-?})"
  else info "AI: no provider key; AI features are off, everything else works"; fi
  info "outbound safe mode: ${OUTBOUND_SAFE_MODE:-strict (unset)}"
fi

# ── services ──────────────────────────────────────────────────────────────
section "services"
check_service() { # name url default-port fix-hint
  local hp host port
  hp="$(host_port "$2" "$3")"
  if [ -z "$hp" ]; then warn "$1: cannot read host/port from its URL"; return; fi
  read -r host port <<<"$hp"
  if listening "$host" "$port"; then pass "$1 reachable at $host:$port"
  else warn "$1 not reachable at $host:$port ($4)"; fi
}
if [ "$ENV_OK" = 1 ]; then
  check_service "Postgres" "${DATABASE_URL:-}" 5432 "make up"
  check_service "Redis" "${REDIS_URL:-}" 6379 "make up"
  check_service "mail catcher (Mailpit)" "smtp://${SMTP_HOST:-localhost}:${SMTP_PORT:-1035}" 1035 "make up"
  web="${WEB_PORT:-3200}"
  if listening 127.0.0.1 "$web"; then info "port $web (web) is in use: your dev server, or something else?"
  else pass "port $web (web) is free"; fi
fi
# @module:mobile
if listening 127.0.0.1 8091; then info "port 8091 (Expo) is in use"; else pass "port 8091 (Expo) is free"; fi
# @end

# ── ml/ (Python sidecar) ──────────────────────────────────────────────────
if [ -d ml ]; then
  section "ml/ (Python sidecar, optional)"
  if command -v uv >/dev/null; then
    pass "uv $(uv --version | awk '{print $2}')"
    if py="$(uv python find 3.12 2>/dev/null)"; then pass "python 3.12 for uv ($py)"
    else info "no Python 3.12 yet: the first uv run downloads one"; fi
    if [ -x ml/.venv/bin/python ]; then pass "ml/.venv exists"; else info "ml/.venv not created yet: cd ml && uv sync"; fi
    if [ -f ml/runs/LATEST ]; then pass "trained model: ml/runs/$(cat ml/runs/LATEST)"
    else info "no trained model yet: cd ml && uv run train"; fi
  elif [ "${ML_ENABLED:-false}" = true ]; then
    fail "ML_ENABLED=true but uv is not installed (curl -LsSf https://astral.sh/uv/install.sh | sh)"
  else
    info "uv not installed; only needed for ml/ (curl -LsSf https://astral.sh/uv/install.sh | sh)"
  fi
  if [ "${ML_ENABLED:-false}" = true ]; then info "ML_ENABLED=true: the worker runs ml.predict"; fi
fi

# ── GPU ───────────────────────────────────────────────────────────────────
section "GPU (optional)"
if command -v nvidia-smi >/dev/null; then
  if gpu="$(with_timeout 10 nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader 2>&1)"; then
    while IFS= read -r line; do pass "NVIDIA $line"; done <<<"$gpu"
  else
    warn "nvidia-smi failed: $(echo "$gpu" | head -1) (after a driver update: reboot)"
  fi
elif [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]; then
  info "Apple Silicon: PyTorch can use MPS"
else
  info "no NVIDIA GPU: fine for the app and the toy model; serve big models elsewhere (ml/serve/)"
fi

echo
if [ "$FAILS" -gt 0 ]; then
  printf '%sdoctor: %d problem(s) to fix, %d warning(s)%s\n' "$R" "$FAILS" "$WARNS" "$N"
  exit 1
fi
if [ "$WARNS" -gt 0 ]; then printf '%sdoctor: ready, with %d warning(s)%s\n' "$Y" "$WARNS" "$N"
else printf '%sdoctor: ready%s\n' "$G" "$N"; fi
