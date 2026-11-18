import json
from pathlib import Path

import pytest

from mlkit import experiments
from mlkit.experiments import (
    ExperimentError,
    find_experiment,
    list_experiments,
    new_experiment,
    record_metrics,
    set_status,
    slugify,
)


def test_new_scaffolds_and_registers(ml_home: Path) -> None:
    exp_id, folder = new_experiment("Bigrams help!", hypothesis="Bigrams raise F1 by 0.02")
    assert exp_id == "EXP-001"
    assert folder == ml_home / "experiments" / "EXP-001-bigrams-help"
    readme = (folder / "README.md").read_text()
    assert readme.startswith("# EXP-001: Bigrams help!")
    assert "Bigrams raise F1 by 0.02" in readme and "{{" not in readme
    # A snapshot of the config at creation time, and an empty metrics file.
    assert (folder / "config.toml").read_text() == (ml_home / "config" / "default.toml").read_text()
    assert json.loads((folder / "metrics.json").read_text()) == {}
    [entry] = list_experiments()
    assert (entry.id, entry.status, entry.folder) == ("EXP-001", "PLANNED", "EXP-001-bigrams-help/")


def test_ids_increment_and_the_rest_of_the_registry_survives(ml_home: Path) -> None:
    new_experiment("one")
    new_experiment("two")
    exp_id, _ = new_experiment("three")
    assert exp_id == "EXP-003"
    assert [e.title for e in list_experiments()] == ["one", "two", "three"]
    text = (ml_home / "experiments" / "REGISTRY.md").read_text()
    assert "## Lessons" in text and "## Current best" in text


def test_a_folder_without_a_row_still_reserves_its_id(ml_home: Path) -> None:
    (ml_home / "experiments" / "EXP-007-hand-made").mkdir()
    assert new_experiment("next")[0] == "EXP-008"


def test_pipes_and_newlines_cannot_break_the_table(ml_home: Path) -> None:
    new_experiment("a | b", hypothesis="x\n| y")
    [entry] = list_experiments()
    assert entry.title == "a | b"
    assert entry.hypothesis == "x | y"


def test_set_status_updates_registry_and_readme(ml_home: Path) -> None:
    _, folder = new_experiment("thing")
    set_status("exp-001", "validated", result="F1 0.80 -> 0.83")
    [entry] = list_experiments()
    assert (entry.status, entry.result) == ("VALIDATED", "F1 0.80 -> 0.83")
    assert "**Status:** VALIDATED" in (folder / "README.md").read_text()
    with pytest.raises(ExperimentError, match="status must be one of"):
        set_status("EXP-001", "DONE")
    with pytest.raises(ExperimentError, match="not in the registry"):
        set_status("EXP-099", "VALIDATED")


def test_find_and_record_metrics(ml_home: Path) -> None:
    _, folder = new_experiment("thing")
    assert find_experiment("EXP-001") == folder
    with pytest.raises(ExperimentError, match="no folder"):
        find_experiment("EXP-002")
    with pytest.raises(ExperimentError, match="not an experiment id"):
        find_experiment("../etc")
    record_metrics(folder, {"run_id": "a", "val": {"f1": 0.5}})
    record_metrics(folder, {"run_id": "b", "val": {"f1": 0.6}})
    data = json.loads((folder / "metrics.json").read_text())
    assert data["latest"]["run_id"] == "b"
    assert [r["run_id"] for r in data["runs"]] == ["a", "b"]


def test_cli(ml_home: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert experiments.main(["list"]) == 0
    assert "no experiments yet" in capsys.readouterr().out
    assert experiments.main(["new", "From the CLI", "--hypothesis", "h"]) == 0
    assert "EXP-001: experiments/EXP-001-from-the-cli/" in capsys.readouterr().out
    assert experiments.main(["set", "EXP-001", "INVALIDATED", "--result", "no gain"]) == 0
    assert experiments.main(["list"]) == 0
    assert "EXP-001  INVALIDATED  From the CLI  -> no gain" in capsys.readouterr().out
    assert experiments.main(["new", "  "]) == 2


def test_slugify() -> None:
    assert slugify("Focal loss (gamma=2) vs. BCE") == "focal-loss-gamma-2-vs-bce"
    assert slugify("!!!") == "experiment"
