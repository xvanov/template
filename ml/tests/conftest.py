"""Every test that writes runs in a throwaway ml/ copy (ML_ROOT=tmp): the real
splits/, runs/ and experiments/ are never touched."""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

import pytest

# Before numpy loads (nothing above imports it): one BLAS thread. The toy
# matrices are tiny, and on a busy machine a thread per core made the suite 5x
# slower (measured: 15 s vs 3 s).
for _var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

REAL_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def ml_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "ml"
    (root / "config").mkdir(parents=True)
    shutil.copyfile(REAL_ROOT / "config" / "default.toml", root / "config" / "default.toml")
    exp = root / "experiments"
    shutil.copytree(REAL_ROOT / "experiments" / "_template", exp / "_template")
    registry = (REAL_ROOT / "experiments" / "REGISTRY.md").read_text()
    # The same file, minus the real experiments' rows.
    (exp / "REGISTRY.md").write_text(re.sub(r"(?m)^\| EXP-.*\n", "", registry))
    monkeypatch.setenv("ML_ROOT", str(root))
    for name in list(os.environ):
        if name.startswith("ML__"):
            monkeypatch.delenv(name)
    return root
