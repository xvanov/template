# ml/ — the Python sidecar

Training, evaluation, experiments, and the bridge the app's worker calls.
A [uv](https://docs.astral.sh/uv/) project (Python 3.12), separate from the
npm workspaces: nothing in `make test`/`make smoke` needs Python, and the
Docker images carry none until you add it (see "Docker" below).

## The one rule: always `uv run`

```bash
uv run train          # right
uv run pytest         # right
python -m mlkit.train # WRONG: whatever `python` is on PATH, with whatever packages
pip install x         # WRONG: use `uv add x` (updates pyproject.toml AND uv.lock)
```

`uv run` syncs `.venv` from `uv.lock` before every command, so you, a teammate,
CI and the worker all run the same versions. A bare `python` on a shared GPU
box is usually someone else's environment. Commit `uv.lock` with every
dependency change (`uv add`, `uv remove`, `uv lock`).

## Ten seconds to a trained model

```bash
cd ml
uv run device         # which device training would use, and why (never crashes)
uv run train          # toy model, CPU, < 1 s: runs/<run_id>/ + runs/LATEST
uv run status         # the latest run's status file
echo '{"items":[{"id":"1","title":"roof leak, fix today"}]}' | uv run predict
uv run pytest         # ~2 s, offline
uv run ruff check && uv run ruff format --check
```

## Layout

```
pyproject.toml, uv.lock   deps (numpy only at runtime), scripts, ruff (line 100, py312), pytest
config/default.toml       the base config (documents every key)
src/mlkit/
  config.py      dataclasses < TOML < ML__SECTION__KEY env < --set section.key=value; unknown keys are errors
  device.py      CUDA / MPS / CPU detection with the reason; require_gpu refuses with a message
  status.py      JSON status file + heartbeat for long runs; `uv run status`
  split.py       fixed train/val split by hash of seed:id, persisted, checked on every load
  runs.py        runs/<run_id>/ and runs/LATEST
  toy.py         the toy problem (is a to-do item urgent?) — replace with yours
  train.py       train + evaluate: `uv run train [--exp EXP-001] [--set k=v] [--resplit]`
  predict.py     JSON stdin -> JSON stdout; the worker bridge's contract
  experiments.py `uv run exp new|list|set`
splits/          committed split files (ids only, never data)
experiments/     REGISTRY.md (hypothesis registry), _template/, EXP-<n>-<slug>/
contract/        predict.example.json: one request + response, tested by Python AND TypeScript
serve/           vllm.sh + health.sh: serve an open model on a GPU box
data/            gitignored (README inside: raw/, processed/, external/)
runs/            gitignored: every run's config, status, metrics, model
```

## Config

```bash
uv run train --set train.epochs=50 --set device.require_gpu=true
ML__TRAIN__LEARNING_RATE=0.1 uv run train      # env: double underscore between parts
uv run train --config path/to/other.toml
```

Every run writes the resolved config to `runs/<id>/config.json` and its hash to
`metrics.json`, with the git commit and a dirty flag, so a number can always be
traced to the code and settings that made it.

## Devices

`uv run device` prints `GPU: CUDA <name>, x/y GB free`, `GPU: Apple MPS`, or
`CPU only (<why>)`: torch missing, no driver, or `nvidia-smi` failing (the
"Driver/library version mismatch" after a driver update without a reboot).
Training never crashes for lack of a GPU; set `device.require_gpu = true` (and
`min_gpu_memory_gb`) to refuse instead of silently training for ten hours on CPU.
The toy model is numpy-only. For a real model: `uv add torch` (on Linux, see
uv's PyTorch guide for the CUDA index), and `device.py` picks it up.

## Status file (for long runs)

`runs/<id>/status.json`, replaced atomically (never half-written), refreshed by
a heartbeat every 30 s even while one step runs for an hour:

```json
{ "schema": 1, "run_id": "run-20261118-153012-ab12", "status": "running",
  "step": 120, "total_steps": 300, "metrics": { "train_loss": 0.41 },
  "eta_seconds": 95, "pid": 4242, "host": "gpu-1", "device": "GPU: CUDA L4 ...",
  "started_at": "...Z", "updated_at": "...Z", "finished_at": null, "errors": [] }
```

`status` is `starting | running | completed | failed | interrupted`. An exception
writes `failed` with the error; Ctrl-C or SIGTERM (`docker stop`, a scheduler)
writes `interrupted`. A reader treats an active run as **stale** when
`updated_at` is older than 5 minutes or, on the same host, its pid is gone:
`uv run status` prints `STALE`; from code, `mlkit.status.read_status(path)`.
The app can read the same file (it is plain JSON); `ssh gpu-box cat .../status.json`
works from a phone.

## The fixed split

`splits/toy.json` assigns each id to train or val by a hash of `seed:id`, so
an id's side never depends on row order or on what else is in the dataset.
It is written once and **committed**. Every later run checks it against the
dataset's ids, the seed and the val fraction, and refuses on any difference
instead of quietly re-splitting (which makes every earlier score
incomparable). `--resplit` makes a new one on purpose: say so in the registry.

## Experiments

```bash
uv run exp new "Bigrams help" --hypothesis "Bigrams raise val F1 by 0.02+"
#   -> experiments/EXP-002-bigrams-help/ (README, config.toml snapshot, metrics.json) + a registry row
uv run train --exp EXP-002          # the experiment's config; metrics appended to its metrics.json
uv run exp set EXP-002 INVALIDATED --result "F1 0.775 -> 0.771, within noise"
uv run exp list
```

Read `experiments/REGISTRY.md` before starting anything. Write the success
criterion in the experiment README **before** running it. Keep negative
results with the reason: "tried, failed, here is why" is what stops the next
person (or agent) from burning a day on it again. `EXP-001` is a filled-in
example; delete it with the toy problem.

## The bridge to the app

The worker runs `uv run --project ml --frozen --no-dev predict` as a child process: JSON
on stdin, JSON on stdout, a timeout (`ML_TIMEOUT_SECONDS`), the child sees only
PATH/HOME (none of the app's secrets). Example job: `ml.predict` scores a
tenant's open items. Code: `packages/jobs/src/ml.ts`.

```bash
cd ml && uv run train                     # a model must exist
# .env: ML_ENABLED=true                   (off by default)
make dev                                  # or make demo
npm run ml:predict -w worker -- demo-acme # queue it for a workspace, by slug
# worker log: [ml] predict org=... model=... items=6 urgent=2
```

**Why a child process and not a Python web service:** a job is already the
slow, retried, recorded unit of work (`job_run`); a process per job adds no port,
no second service to deploy and watch, and no Python anywhere unless
`ML_ENABLED` is on. It costs ~0.5 s of start-up per call. That is wrong for a
large model that takes 30 s to load: serve that one with vLLM (below) and call
it through `packages/ai` as `local/<model>`. If you later need a warm,
non-LLM model behind an HTTP API, that is the time for FastAPI, not before.

Contract: `src/mlkit/predict.py` (docstring) and `contract/predict.example.json`,
which `tests/test_train_predict.py` checks against the real output and
`packages/jobs/src/ml.test.ts` parses with the worker's zod schema. Change all
three together. Expected failures (no model yet, bad input) are
`{"ok": false, "reason"}` and are recorded, not retried; a crash or a timeout
throws and the job retries.

### Docker

The worker image (`apps/worker/Dockerfile`, node:22-alpine) has no Python, on
purpose. To run the bridge in it, add after the `runner` stage's `COPY` lines:

```dockerfile
COPY --from=ghcr.io/astral-sh/uv:0.10.7 /uv /usr/local/bin/uv
COPY ml/pyproject.toml ml/uv.lock ml/.python-version ml/README.md /app/ml/
COPY ml/src /app/ml/src
COPY ml/config /app/ml/config
RUN cd /app/ml && UV_PYTHON_INSTALL_DIR=/opt/python uv sync --frozen --no-dev \
  && chown -R node:node /app/ml
# Use the environment built above as-is: at runtime `uv run` must not try to
# re-sync (as the node user, with no cache and maybe no network, it fails).
ENV UV_NO_SYNC=1
```

then set `ML_ENABLED=true` and `ML_PROJECT_DIR=/app/ml`, and put the model
where `ml/runs/LATEST` says (a volume: `-v ./ml/runs:/app/ml/runs`). `turbo prune`
does not carry `ml/` (it is not a workspace), hence the explicit `COPY`s; the
root `.dockerignore` keeps `ml/data`, `ml/runs` and `.venv` out of the context.
Measured with this snippet: about +200 MB (Python 90 MB, the venv with numpy
58 MB, uv 50 MB), and `train` + `predict` run in the container with no network.
numpy has musl wheels; **torch does not**: for torch, base the worker image on
`node:22-bookworm-slim` instead of alpine.

## Serving a model (vLLM)

On a GPU box (Docker + nvidia-container-toolkit):

```bash
ml/serve/vllm.sh start          # Qwen/Qwen3-8B as "qwen3-8b" on 127.0.0.1:8000; MODEL=... SERVED=... to change
ml/serve/vllm.sh logs           # download + load progress
ml/serve/health.sh --wait 900   # /v1/models AND a 1-token completion (a hung engine still lists models)
```

Defaults worth knowing: pinned image `vllm/vllm-openai:v0.27.1` (a floating tag
changes under you mid-event), bound to `127.0.0.1` (reach it with
`ssh -N -L 8000:127.0.0.1:8000 gpu-box`, never by opening the port), an API key
generated into `~/.config/vllm/vllm.env`, `--enable-prefix-caching` (every app
request repeats the same system prompt: large time-to-first-token win under
load), a reasoning parser so "thinking" never leaks into answers, tool-call
parsing on, `--restart unless-stopped` (an engine crash recovers in about a
minute without you). Lower `MAX_LEN` or `GPU_UTIL` if it runs out of memory at
start; `vllm.sh` lists every knob.

Point the app at it (`.env`):

```bash
LLM_MODEL_FAST=local/qwen3-8b            # the SERVED name, under local/
LLM_BASE_URL=http://127.0.0.1:8000/v1    # through the ssh tunnel
LLM_API_KEY=<VLLM_API_KEY from ~/.config/vllm/vllm.env>
LLM_PRICES=local/qwen3-8b=0:0            # free: without a price, the daily cap refuses optional calls
```

**No GPU?** The same `local/` settings work with any OpenAI-compatible server:
[Ollama](https://ollama.com) (`ollama pull qwen3:4b`; `LLM_BASE_URL=http://localhost:11434/v1`,
`LLM_MODEL_FAST=local/qwen3:4b`, no key) or llama.cpp's `llama-server -m model.gguf --port 8080`
(`LLM_BASE_URL=http://localhost:8080/v1`). A 4B model at 4-bit runs on a laptop
CPU at a few tokens per second: fine for a demo of one request, not for load.
`ml/serve/health.sh --base <url>` checks any of them.
