"""Where ml/ is. Every relative path in the config resolves against it, so a
script behaves the same from the repo root, from ml/, or from the worker."""

from __future__ import annotations

import os
from pathlib import Path


def ml_root() -> Path:
    """$ML_ROOT if set; else the ml/ this package's source lives in (src/mlkit -> ml,
    true for uv's default editable install); else the current directory (a
    non-editable install, run from ml/ as the worker does)."""
    env = os.environ.get("ML_ROOT")
    if env:
        return Path(env).resolve()
    source_root = Path(__file__).resolve().parents[2]
    if (source_root / "pyproject.toml").exists():
        return source_root
    return Path.cwd()
