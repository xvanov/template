import json
from pathlib import Path

import pytest

from mlkit.split import SplitMismatchError, assign, load_or_create

IDS = [f"row-{i}" for i in range(500)]


def test_deterministic_and_order_independent() -> None:
    a = assign(IDS, 0.2, seed=42)
    b = assign(list(reversed(IDS)), 0.2, seed=42)
    assert a == b
    assert 70 < len(a.val) < 130  # ~20%
    assert set(a.train).isdisjoint(a.val)
    assert set(a.train) | set(a.val) == set(IDS)


def test_adding_rows_never_moves_existing_ones() -> None:
    a = assign(IDS, 0.2, seed=42)
    b = assign([*IDS, "row-new-1", "row-new-2"], 0.2, seed=42)
    assert set(a.val) <= set(b.val)
    assert set(a.train) <= set(b.train)


def test_seed_changes_the_split() -> None:
    assert assign(IDS, 0.2, seed=1).val != assign(IDS, 0.2, seed=2).val


def test_duplicates_are_refused() -> None:
    with pytest.raises(ValueError, match="unique"):
        assign(["a", "a", "b"], 0.5, seed=0)


def test_persisted_once_then_loaded(tmp_path: Path) -> None:
    p = tmp_path / "splits" / "s.json"
    first, created = load_or_create(p, IDS, 0.2, 42)
    assert created and p.exists()
    on_disk = json.loads(p.read_text())
    assert on_disk["n_val"] == len(first.val)
    second, created = load_or_create(p, reversed(IDS), 0.2, 42)
    assert not created and second == first


@pytest.mark.parametrize(
    ("ids", "frac", "seed", "message"),
    [
        ([*IDS, "extra"], 0.2, 42, "1 new, 0 gone"),
        (IDS[:-3], 0.2, 42, "0 new, 3 gone"),
        (IDS, 0.2, 7, "seed 7"),
        (IDS, 0.25, 42, "val_fraction 0.25"),
    ],
)
def test_a_changed_dataset_or_setting_refuses(
    tmp_path: Path, ids: list[str], frac: float, seed: int, message: str
) -> None:
    p = tmp_path / "s.json"
    load_or_create(p, IDS, 0.2, 42)
    with pytest.raises(SplitMismatchError, match=message):
        load_or_create(p, ids, frac, seed)


def test_resplit_is_explicit(tmp_path: Path) -> None:
    p = tmp_path / "s.json"
    load_or_create(p, IDS, 0.2, 42)
    split, created = load_or_create(p, [*IDS, "extra"], 0.2, 42, resplit=True)
    assert created and "extra" in split.train + split.val
