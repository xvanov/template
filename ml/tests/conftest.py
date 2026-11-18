"""Every test that writes runs in a throwaway ml/ copy (ML_ROOT=tmp): the real
splits/, runs/ and experiments/ are never touched."""

from __future__ import annotations

import re
import shutil
from pathlib import Path

import pytest

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
    for name in list(__import__("os").environ):
        if name.startswith("ML__"):
            monkeypatch.delenv(name)
    return root
