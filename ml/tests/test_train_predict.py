"""The toy pipeline end to end, on CPU, in a throwaway ml/ copy."""

import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

from mlkit import predict as predict_mod
from mlkit import train as train_mod
from mlkit.config import load_config
from mlkit.experiments import new_experiment
from mlkit.runs import latest_run_dir
from mlkit.status import read_status

CONTRACT = Path(__file__).resolve().parents[1] / "contract" / "predict.example.json"


def test_train_is_deterministic_and_writes_a_complete_run(ml_home: Path) -> None:
    cfg = load_config()
    a = train_mod.train(cfg, "run-a", heartbeat_seconds=0)
    b = train_mod.train(cfg, "run-b", heartbeat_seconds=0)
    assert a["val"] == b["val"]  # same config + same split = same numbers
    assert a["val"]["accuracy"] > 0.75  # it learned something
    run = ml_home / "runs" / "run-b"
    for name in ("config.json", "metrics.json", "model.json", "status.json"):
        assert (run / name).exists(), name
    assert read_status(run / "status.json")["status"] == "completed"
    assert latest_run_dir(cfg) == run
    assert (ml_home / "splits" / "toy.json").exists()  # written once ...
    assert not train_mod.main(["--run-id", "run-c"])  # ... and reused


def test_a_changed_dataset_refuses_the_old_split(
    ml_home: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert train_mod.main(["--run-id", "r1"]) == 0
    assert train_mod.main(["--run-id", "r2", "--set", "data.n_samples=700"]) == 2
    assert "--resplit" in capsys.readouterr().err
    assert train_mod.main(["--run-id", "r3", "--set", "data.n_samples=700", "--resplit"]) == 0


def test_train_with_an_experiment_records_metrics(ml_home: Path) -> None:
    _, folder = new_experiment("baseline")
    assert train_mod.main(["--exp", "EXP-001", "--run-id", "exp-001-x"]) == 0
    data = json.loads((folder / "metrics.json").read_text())
    assert data["latest"]["run_id"] == "exp-001-x"
    assert train_mod.main(["--exp", "EXP-404"]) == 2


def test_require_gpu_on_a_cpu_box_exits_cleanly(ml_home: Path, monkeypatch) -> None:
    from mlkit import device

    monkeypatch.setattr(device, "_torch", lambda: None)
    monkeypatch.setattr(device, "_nvidia_smi", lambda: (None, None))
    with pytest.raises(SystemExit, match="require_gpu"):
        train_mod.main(["--set", "device.require_gpu=true"])


def _run_predict(monkeypatch, payload: str, argv=None) -> dict:
    monkeypatch.setattr(sys, "stdin", io.StringIO(payload))
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    assert predict_mod.main(argv or []) == 0
    return json.loads(out.getvalue())


def test_predict_before_any_training_says_what_to_do(ml_home: Path, monkeypatch) -> None:
    res = _run_predict(monkeypatch, '{"items": []}')
    assert res == {"ok": False, "reason": "no trained model yet: run `cd ml && uv run train`"}


@pytest.mark.parametrize(
    ("payload", "reason"),
    [
        ("not json", "not JSON"),
        ('{"things": []}', 'expected {"items"'),
        ('{"items": [{"title": "x"}]}', "items[0] needs a string id"),
        ('{"items": [{"id": "1", "title": 5}]}', "string title"),
        (json.dumps({"items": [{"id": str(i), "title": "x"} for i in range(1001)]}), "at most"),
    ],
)
def test_bad_requests_are_answers_not_crashes(
    ml_home: Path, monkeypatch, payload: str, reason: str
) -> None:
    res = _run_predict(monkeypatch, payload)
    assert res["ok"] is False and reason in res["reason"]


def _shape(v):
    """The JSON shape of a value: types, keys, list element shapes."""
    if isinstance(v, dict):
        return {k: _shape(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_shape(v[0])] if v else []
    return type(v).__name__


def test_the_contract_example_matches_what_predict_returns(ml_home: Path, monkeypatch) -> None:
    """ml/contract/predict.example.json is also parsed by the worker's tests
    (packages/jobs/src/ml.test.ts): if this passes, both sides agree."""
    example = json.loads(CONTRACT.read_text())
    train_mod.main(["--run-id", "contract-run"])
    res = _run_predict(monkeypatch, json.dumps(example["request"]))
    assert _shape(res) == _shape(example["response"])
    assert [p["id"] for p in res["predictions"]] == [i["id"] for i in example["request"]["items"]]
    by_id = {p["id"]: p for p in res["predictions"]}
    assert by_id["a"]["urgent"] is True  # "Roof leak over the kitchen, fix today"
    assert by_id["b"]["urgent"] is False  # "Someday: explore a newsletter idea"


def test_predict_as_a_real_process(ml_home: Path) -> None:
    """What the worker does: a separate process, JSON over stdin/stdout, logs on stderr."""
    train_mod.main(["--run-id", "proc-run"])
    proc = subprocess.run(
        [sys.executable, "-m", "mlkit.predict"],
        input=json.dumps({"items": [{"id": "1", "title": "server down, fix asap"}]}),
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    res = json.loads(proc.stdout)  # stdout holds exactly one JSON document
    assert res["ok"] is True and res["model"]["run_id"] == "proc-run"
