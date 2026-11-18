"""Atomic, durable file writes.

Write to a temp file in the same directory, fsync it, rename it over the
target, fsync the directory. A reader sees the old file or the new one, never
half of one; and after a power cut the rename is not lost while the data is
(which an un-fsynced rename allows on ext4/xfs).
"""

from __future__ import annotations

import contextlib
import os
import tempfile
from pathlib import Path


def _fsync_dir(directory: Path) -> None:
    # Not possible on Windows (and not needed there); best effort elsewhere.
    with contextlib.suppress(OSError, AttributeError):
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def write_text_atomic(path: str | Path, text: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    _fsync_dir(path.parent)
