#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Is an OpenAI-compatible server (vLLM, Ollama, llama.cpp) really serving?
#
#   ml/serve/health.sh                         one check of http://127.0.0.1:8000/v1
#   ml/serve/health.sh --base http://gpu:8000/v1
#   ml/serve/health.sh --wait 900              poll until healthy (a first start
#                                              downloads and loads the weights)
#
# Two checks, because a hung engine still lists its models: GET /models, then
# a ONE-token chat completion with a 60s timeout. Exit 0 = both answered.
# The key: $VLLM_API_KEY, else $LLM_API_KEY, else VLLM_API_KEY from
# ~/.config/vllm/vllm.env (what vllm.sh writes). Never printed.
# ──────────────────────────────────────────────────────────────────────────
set -uo pipefail

BASE="http://127.0.0.1:8000/v1"
WAIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:?--base needs a URL}"; shift 2 ;;
    --wait) WAIT="${2:?--wait needs seconds}"; shift 2 ;;
    -h | --help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "health.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
BASE="${BASE%/}"

KEY="${VLLM_API_KEY:-${LLM_API_KEY:-}}"
ENV_FILE="${ENV_FILE:-$HOME/.config/vllm/vllm.env}"
if [ -z "$KEY" ] && [ -r "$ENV_FILE" ]; then
  KEY="$(sed -n 's/^VLLM_API_KEY=//p' "$ENV_FILE" | head -1)"
fi
# The key goes to curl as a config file on stdin, never on its command line
# (where `ps` shows it to every user on the box).
curl_auth() {
  if [ -n "$KEY" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$KEY" | curl -K - "$@"
  else
    curl "$@"
  fi
}

check() {
  local models model code
  models="$(curl_auth -s -m 10 -w '\n%{http_code}' "$BASE/models" 2>/dev/null)" || {
    echo "DOWN  $BASE/models: no answer"
    return 1
  }
  code="${models##*$'\n'}"
  models="${models%$'\n'*}"
  if [ "$code" = 401 ] || [ "$code" = 403 ]; then
    echo "AUTH  $BASE/models: HTTP $code (wrong or missing key: VLLM_API_KEY / LLM_API_KEY)"
    return 1
  fi
  model="$(printf '%s' "$models" | grep -o '"id" *: *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  if [ -z "$model" ]; then
    echo "DOWN  $BASE/models: HTTP $code without a model: $(printf '%s' "$models" | head -c 200)"
    return 1
  fi
  code="$(curl_auth -s -o /dev/null -w '%{http_code}' -m 60 \
    -H 'Content-Type: application/json' "$BASE/chat/completions" \
    -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}")"
  if [ "$code" != 200 ]; then
    echo "SICK  $BASE: lists \"$model\" but a 1-token completion returned HTTP $code"
    return 1
  fi
  echo "OK    $BASE serves \"$model\" (models + 1-token completion)"
}

if [ "$WAIT" -le 0 ]; then
  check
  exit $?
fi
deadline=$((SECONDS + WAIT))
until out="$(check)"; do
  if [ $SECONDS -ge $deadline ]; then
    echo "$out"
    echo "gave up after ${WAIT}s (vllm.sh logs shows why)"
    exit 1
  fi
  sleep 10
done
echo "$out"
