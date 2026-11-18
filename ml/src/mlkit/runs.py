"""Run directories: ``runs/<run_id>/`` holds everything one training run made
(config snapshot, status, metrics, model). ``runs/LATEST`` names the newest
completed one; it is a plain file, not a symlink, so it works on every OS.
runs/ is gitignored: models and checkpoints never go in git."""

from __future__ import annotations

import re
import secrets
from datetime import UTC, datetime
from pathlib import Path

from mlkit.config import Config
from mlkit.fsutil import write_text_atomic

_SAFE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")


def new_run_id(prefix: str = "run") -> str:
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    return f"{prefix}-{stamp}-{secrets.token_hex(2)}"


def runs_dir(cfg: Config) -> Path:
    return cfg.resolve(cfg.paths.runs)


def run_dir(cfg: Config, run_id: str) -> Path:
    if not _SAFE.match(run_id):
        raise ValueError(f"bad run id {run_id!r}")
    return runs_dir(cfg) / run_id


def mark_latest(cfg: Config, run_id: str) -> None:
    write_text_atomic(runs_dir(cfg) / "LATEST", run_id + "\n")


def latest_run_dir(cfg: Config) -> Path | None:
    f = runs_dir(cfg) / "LATEST"
    if not f.exists():
        return None
    run_id = f.read_text().strip()
    if not _SAFE.match(run_id):
        return None
    d = runs_dir(cfg) / run_id
    return d if d.is_dir() else None
