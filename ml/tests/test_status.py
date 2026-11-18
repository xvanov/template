import json
import time
from pathlib import Path

import pytest

from mlkit.status import RunStatus, read_status, write_atomic


def test_lifecycle_completed(tmp_path: Path) -> None:
    p = tmp_path / "status.json"
    with RunStatus(p, "r1", total_steps=10, heartbeat_seconds=0) as st:
        assert json.loads(p.read_text())["status"] == "starting"
        st.update(step=5, metrics={"loss": 0.5})
        mid = json.loads(p.read_text())
        assert mid["status"] == "running" and mid["step"] == 5
        assert mid["metrics"] == {"loss": 0.5}
        assert mid["eta_seconds"] is not None
    done = read_status(p)
    assert done["status"] == "completed" and done["finished_at"] and not done["stale"]
    assert done["schema"] == 1
    assert list(tmp_path.iterdir()) == [p]  # no temp files left behind


def test_exception_is_recorded_as_failed(tmp_path: Path) -> None:
    p = tmp_path / "status.json"
    with pytest.raises(ValueError), RunStatus(p, "r2", heartbeat_seconds=0):
        raise ValueError("nan loss")
    s = read_status(p)
    assert s["status"] == "failed"
    assert s["errors"] == ["ValueError: nan loss"]


def test_ctrl_c_is_recorded_as_interrupted(tmp_path: Path) -> None:
    p = tmp_path / "status.json"
    with pytest.raises(KeyboardInterrupt), RunStatus(p, "r3", heartbeat_seconds=0):
        raise KeyboardInterrupt
    assert read_status(p)["status"] == "interrupted"


def test_heartbeat_refreshes_updated_at(tmp_path: Path) -> None:
    p = tmp_path / "status.json"
    with RunStatus(p, "r4", heartbeat_seconds=0.05):
        first = json.loads(p.read_text())["updated_at"]
        deadline = time.monotonic() + 3
        while json.loads(p.read_text())["updated_at"] == first:
            assert time.monotonic() < deadline, "heartbeat never wrote"
            time.sleep(0.05)


def test_unknown_field_is_an_error(tmp_path: Path) -> None:
    st = RunStatus(tmp_path / "s.json", "r5", heartbeat_seconds=0)
    with pytest.raises(AttributeError):
        st.update(epochz=1)


def _write(p: Path, **fields: object) -> None:
    base = {"run_id": "x", "status": "running", "step": 1, "errors": [], "metrics": {}}
    write_atomic(p, {**base, **fields})


def test_stale_when_no_heartbeat(tmp_path: Path) -> None:
    p = tmp_path / "s.json"
    _write(p, updated_at="2020-01-01T00:00:00Z", host="elsewhere", pid=1)
    assert read_status(p)["stale"] is True


def test_stale_when_the_process_is_gone(tmp_path: Path) -> None:
    import socket
    from datetime import UTC, datetime

    now = datetime.now(UTC).isoformat()
    p = tmp_path / "s.json"
    _write(p, updated_at=now, host=socket.gethostname(), pid=2**22 + 12345)
    assert read_status(p)["stale"] is True
    _write(p, updated_at=now, host=socket.gethostname(), pid=__import__("os").getpid())
    assert read_status(p)["stale"] is False


def test_finished_runs_are_never_stale(tmp_path: Path) -> None:
    p = tmp_path / "s.json"
    _write(p, status="completed", updated_at="2020-01-01T00:00:00Z")
    assert read_status(p)["stale"] is False
