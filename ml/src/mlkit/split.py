"""A fixed train/val split, persisted to disk and checked on every load.

Why a file and not ``train_test_split(seed=42)``: a seeded shuffle gives a
different split as soon as the row order or the row count changes (a new data
dump, a filter, a teammate's pandas version), and validation scores stop
being comparable across experiments without anyone noticing. Here:

* each id goes to train or val by a hash of ``seed:id``, not by its position,
  so the assignment of an id never depends on what else is in the dataset;
* the split is written once (``splits/<name>.json``, commit it) and every
  later run loads it and REFUSES if the dataset's ids, the seed or the val
  fraction no longer match, instead of quietly re-splitting;
* ``resplit=True`` (``--resplit``) is the explicit way to make a new one,
  which invalidates comparisons with earlier runs. Record that in the registry.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from mlkit.status import write_atomic

SCHEMA = 1


class SplitMismatchError(RuntimeError):
    """The split on disk does not belong to this dataset or these settings."""


@dataclass(frozen=True)
class Split:
    train: list[str]
    val: list[str]
    seed: int
    val_fraction: float
    ids_sha256: str


def ids_digest(ids: Iterable[str]) -> str:
    h = hashlib.sha256()
    for i in sorted(ids):
        h.update(i.encode())
        h.update(b"\n")
    return h.hexdigest()


def bucket(id_: str, seed: int) -> float:
    """A stable number in [0, 1) for this id and seed (independent of everything else)."""
    digest = hashlib.sha256(f"{seed}:{id_}".encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def assign(ids: Iterable[str], val_fraction: float, seed: int) -> Split:
    ids = list(ids)
    if len(set(ids)) != len(ids):
        raise ValueError("ids must be unique")
    if not 0 < val_fraction < 1:
        raise ValueError(f"val_fraction must be in (0, 1), got {val_fraction}")
    train, val = [], []
    for i in sorted(ids):
        (val if bucket(i, seed) < val_fraction else train).append(i)
    if not train or not val:
        raise ValueError(f"split of {len(ids)} ids left one side empty; use more data")
    return Split(train, val, seed, val_fraction, ids_digest(ids))


def save(split: Split, path: Path) -> None:
    write_atomic(
        path,
        {
            "schema": SCHEMA,
            "seed": split.seed,
            "val_fraction": split.val_fraction,
            "n_train": len(split.train),
            "n_val": len(split.val),
            "ids_sha256": split.ids_sha256,
            "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "train": split.train,
            "val": split.val,
        },
    )


def load(path: Path) -> Split:
    data = json.loads(path.read_text())
    return Split(
        train=list(data["train"]),
        val=list(data["val"]),
        seed=int(data["seed"]),
        val_fraction=float(data["val_fraction"]),
        ids_sha256=str(data["ids_sha256"]),
    )


def load_or_create(
    path: str | Path,
    ids: Iterable[str],
    val_fraction: float,
    seed: int,
    resplit: bool = False,
) -> tuple[Split, bool]:
    """(split, created). Loads ``path`` and checks it, or writes a new one."""
    path = Path(path)
    ids = list(ids)
    if path.exists() and not resplit:
        split = load(path)
        problems = []
        if split.ids_sha256 != ids_digest(ids):
            known = set(split.train) | set(split.val)
            now = set(ids)
            problems.append(
                f"the dataset's ids changed ({len(now - known)} new, {len(known - now)} gone)"
            )
        if split.seed != seed:
            problems.append(f"seed {seed} != the split's {split.seed}")
        if abs(split.val_fraction - val_fraction) > 1e-12:
            problems.append(f"val_fraction {val_fraction} != the split's {split.val_fraction}")
        if problems:
            raise SplitMismatchError(
                f"{path}: " + "; ".join(problems) + ". Scores against the old split are no "
                "longer comparable. Re-run with --resplit to write a new split on purpose."
            )
        return split, False
    split = assign(ids, val_fraction, seed)
    save(split, path)
    return split, True
