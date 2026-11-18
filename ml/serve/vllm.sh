#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Serve an open model with vLLM's OpenAI-compatible server, in Docker, on a
# GPU box. Runs ON the GPU machine (copy this file there, or clone the repo).
#
#   ml/serve/vllm.sh start      (re)start the container in the background
#   ml/serve/vllm.sh status     is it up? does it answer?
#   ml/serve/vllm.sh logs       follow the server log (model download, load, errors)
#   ml/serve/vllm.sh stop
#
# Then from the app's machine (or this one): ml/serve/health.sh --wait 900
# Point the app at it (ml/README.md, "Serving a model"):
#   LLM_MODEL_FAST=local/<SERVED>  LLM_BASE_URL=http://127.0.0.1:8000/v1
#   LLM_API_KEY=<VLLM_API_KEY>     LLM_PRICES=local/<SERVED>=0:0
#
# Settings (environment; defaults in brackets):
#   MODEL        Hugging Face id                          [Qwen/Qwen3-8B]
#   SERVED       the name clients use (stable across checkpoints) [qwen3-8b]
#   PORT         host port                                [8000]
#   BIND         host address. 127.0.0.1 = reachable only on this box or
#                through `ssh -L`; never 0.0.0.0 on a public machine [127.0.0.1]
#   MAX_LEN      context length (smaller = more room for the KV cache) [32768]
#   GPU_UTIL     fraction of GPU memory vLLM may take     [0.90]
#   MAX_SEQS     requests decoded together                [64]
#   REASONING    vLLM reasoning parser, so "thinking" text never leaks into
#                the answer or tool arguments; "" = off   [qwen3]
#   TOOLS        tool-call parser for function calling; "" = off [hermes]
#   IMAGE        vLLM image, PINNED (a floating tag changes under you) [vllm/vllm-openai:v0.27.1]
#   NAME         container name                           [vllm]
#   ENV_FILE     file with VLLM_API_KEY=... (and HF_TOKEN=... for gated
#                models), mode 600, never printed         [~/.config/vllm/vllm.env]
#   HF_CACHE     model download cache, kept across restarts [~/.cache/huggingface]
#   EXTRA_ARGS   appended verbatim, e.g. "--enforce-eager" []
#   DOCKER       docker command, e.g. "sudo docker"        [docker]
#
# The container restarts itself after a crash or a reboot
# (--restart unless-stopped): an engine fault at 3 a.m. comes back in ~1 min.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

MODEL=${MODEL:-Qwen/Qwen3-8B}
SERVED=${SERVED:-qwen3-8b}
PORT=${PORT:-8000}
BIND=${BIND:-127.0.0.1}
MAX_LEN=${MAX_LEN:-32768}
GPU_UTIL=${GPU_UTIL:-0.90}
MAX_SEQS=${MAX_SEQS:-64}
REASONING=${REASONING-qwen3}
TOOLS=${TOOLS-hermes}
IMAGE=${IMAGE:-vllm/vllm-openai:v0.27.1}
NAME=${NAME:-vllm}
ENV_FILE=${ENV_FILE:-$HOME/.config/vllm/vllm.env}
HF_CACHE=${HF_CACHE:-$HOME/.cache/huggingface}
EXTRA_ARGS=${EXTRA_ARGS:-}
read -r -a DOCKER <<<"${DOCKER:-docker}"

die() { echo "vllm.sh: $*" >&2; exit 1; }

ensure_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    mkdir -p "$(dirname "$ENV_FILE")"
    # A generated key: the server is OpenAI-compatible, so without one anything
    # that reaches the port can use your GPU.
    (umask 077 && printf 'VLLM_API_KEY=%s\n' "$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')" >"$ENV_FILE")
    echo "wrote $ENV_FILE with a generated VLLM_API_KEY (put the same value in the app's LLM_API_KEY)"
  fi
  grep -q '^VLLM_API_KEY=.' "$ENV_FILE" || die "$ENV_FILE has no VLLM_API_KEY=..."
  local mode
  mode="$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %Lp "$ENV_FILE")"
  if [ "$mode" != 600 ]; then
    chmod 600 "$ENV_FILE"
    echo "warning: $ENV_FILE was mode $mode (other users could read the key); set it to 600" >&2
  fi
}

start() {
  command -v "${DOCKER[0]}" >/dev/null || die "docker is not installed"
  "${DOCKER[@]}" info >/dev/null 2>&1 || die "cannot talk to docker (try DOCKER=\"sudo docker\")"
  "${DOCKER[@]}" info 2>/dev/null | grep -qi 'nvidia' \
    || echo "warning: docker reports no nvidia runtime; --gpus all may fail (install nvidia-container-toolkit)" >&2
  ensure_env_file
  mkdir -p "$HF_CACHE"

  local args=(
    --model "$MODEL"
    --served-model-name "$SERVED"
    --host 0.0.0.0 --port 8000
    --max-model-len "$MAX_LEN"
    --gpu-memory-utilization "$GPU_UTIL"
    --max-num-seqs "$MAX_SEQS"
    # Every request of an app repeats the same system prompt (and tool
    # schemas); caching it is the cheapest big win on time to first token.
    --enable-prefix-caching
  )
  if [ -n "$REASONING" ]; then args+=(--reasoning-parser "$REASONING"); fi
  if [ -n "$TOOLS" ]; then args+=(--enable-auto-tool-choice --tool-call-parser "$TOOLS"); fi
  # shellcheck disable=SC2206  # EXTRA_ARGS is deliberately word-split
  if [ -n "$EXTRA_ARGS" ]; then args+=($EXTRA_ARGS); fi

  "${DOCKER[@]}" rm -f "$NAME" >/dev/null 2>&1 || true
  "${DOCKER[@]}" run -d --name "$NAME" --restart unless-stopped \
    --gpus all --ipc=host \
    -p "$BIND:$PORT:8000" \
    -v "$HF_CACHE:/root/.cache/huggingface" \
    --env-file "$ENV_FILE" \
    "$IMAGE" "${args[@]}" >/dev/null
  echo "started $NAME: $MODEL as \"$SERVED\" on http://$BIND:$PORT/v1 (image $IMAGE)"
  echo "first start downloads the weights; watch it with: $0 logs"
  echo "ready when: $(dirname "$0")/health.sh --wait 900"
}

case "${1:-}" in
  start) start ;;
  stop) "${DOCKER[@]}" rm -f "$NAME" >/dev/null 2>&1 && echo "stopped $NAME" || echo "$NAME was not running" ;;
  logs) exec "${DOCKER[@]}" logs -f --tail 100 "$NAME" ;;
  status)
    "${DOCKER[@]}" ps -a --filter "name=^${NAME}$" --format '{{.Names}}: {{.Status}} ({{.Image}})'
    exec "$(dirname "$0")/health.sh" --base "http://127.0.0.1:$PORT/v1"
    ;;
  *) sed -n '2,40p' "$0"; exit 2 ;;
esac
