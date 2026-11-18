"""A JSON status file for long runs: what is it doing, is it still alive?

The writer replaces the file atomically (temp file + rename), so a reader
(``uv run status``, a phone over ssh, the app's worker) never sees half a
file. A background heartbeat refreshes ``updated_at`` even while one step
takes an hour, so "no update for 5 minutes" really means "dead".

    with RunStatus(path, run_id="r1", total_steps=300) as st:
        for epoch in range(300):
            ...
            st.update(step=epoch + 1, metrics={"loss": loss})
    # leaving the block marks it "completed"; an exception marks it
    # "failed" (with the error), Ctrl-C / SIGTERM "interrupted".

The shape is versioned (``schema``) and documented in ml/README.md.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import signal
import socket
import sys
import tempfile
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from types import FrameType, TracebackType
from typing import Any

SCHEMA = 1
STATES = ("starting", "running", "completed", "failed", "interrupted")
ACTIVE = ("starting", "running")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse(ts: str) -> datetime | None:
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


@dataclass
class StatusData:
    run_id: str
    status: str = "starting"
    step: int = 0
    total_steps: int | None = None
    message: str = ""
    metrics: dict[str, float] = field(default_factory=dict)
    eta_seconds: int | None = None
    pid: int = field(default_factory=os.getpid)
    host: str = field(default_factory=socket.gethostname)
    device: str = ""
    started_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)
    finished_at: str | None = None
    errors: list[str] = field(default_factory=list)
    schema: int = SCHEMA


def write_atomic(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


class RunStatus:
    """Writes the status file; use as a context manager (see module docstring)."""

    def __init__(
        self,
        path: str | Path,
        run_id: str,
        total_steps: int | None = None,
        heartbeat_seconds: float = 30.0,
        device: str = "",
    ) -> None:
        self.path = Path(path)
        self.data = StatusData(run_id=run_id, total_steps=total_steps, device=device)
        self.heartbeat_seconds = heartbeat_seconds
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._t0 = time.monotonic()
        self._old_sigterm: Any = None
        self.save()

    # -- writing ---------------------------------------------------------
    def save(self) -> None:
        with self._lock:
            self.data.updated_at = _now()
            write_atomic(self.path, asdict(self.data))

    def update(self, **fields: Any) -> None:
        with self._lock:
            for key, value in fields.items():
                if not hasattr(self.data, key):
                    raise AttributeError(f"unknown status field {key!r}")
                if key == "metrics":
                    self.data.metrics.update({k: float(v) for k, v in value.items()})
                else:
                    setattr(self.data, key, value)
            if self.data.status == "starting" and "step" in fields:
                self.data.status = "running"
            d = self.data
            if d.total_steps and d.step > 0 and d.status == "running":
                elapsed = time.monotonic() - self._t0
                d.eta_seconds = int(elapsed / d.step * (d.total_steps - d.step))
        self.save()

    def finish(self, status: str, error: str | None = None) -> None:
        assert status in STATES, status
        with self._lock:
            self.data.status = status
            self.data.finished_at = _now()
            self.data.eta_seconds = 0 if status == "completed" else None
            if error:
                self.data.errors.append(error[:2000])
        self.save()

    # -- heartbeat -------------------------------------------------------
    def _beat(self) -> None:
        while not self._stop.wait(self.heartbeat_seconds):
            # A full disk must not kill the run; the next beat retries.
            with contextlib.suppress(OSError):
                self.save()

    def __enter__(self) -> RunStatus:
        if self.heartbeat_seconds > 0:
            self._thread = threading.Thread(target=self._beat, daemon=True)
            self._thread.start()
        # SIGTERM (kill, docker stop, a scheduler) becomes KeyboardInterrupt, so it
        # is recorded as "interrupted" instead of the file saying "running" forever.
        if threading.current_thread() is threading.main_thread():
            self._old_sigterm = signal.signal(signal.SIGTERM, self._on_sigterm)
        return self

    def _on_sigterm(self, signum: int, frame: FrameType | None) -> None:
        raise KeyboardInterrupt("SIGTERM")

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        if self._old_sigterm is not None:
            signal.signal(signal.SIGTERM, self._old_sigterm)
        if exc_type is None:
            self.finish("completed")
        elif issubclass(exc_type, KeyboardInterrupt):
            self.finish("interrupted", str(exc) or "interrupted")
        else:
            self.finish("failed", f"{exc_type.__name__}: {exc}")


# -- reading ---------------------------------------------------------------
def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def read_status(path: str | Path, stale_after_seconds: float = 300.0) -> dict[str, Any]:
    """The file's content plus ``stale`` and ``age_seconds``.

    ``stale`` is true for a run that says it is active but has not written for
    ``stale_after_seconds``, or whose process is gone (same host only).
    """
    data = json.loads(Path(path).read_text())
    updated = _parse(data.get("updated_at", ""))
    age = (datetime.now(UTC) - updated).total_seconds() if updated else None
    stale = False
    if data.get("status") in ACTIVE:
        if age is None or age > stale_after_seconds:
            stale = True
        elif data.get("host") == socket.gethostname() and isinstance(data.get("pid"), int):
            stale = not _pid_alive(data["pid"])
    data["age_seconds"] = None if age is None else round(age, 1)
    data["stale"] = stale
    return data


def main(argv: list[str] | None = None) -> int:
    from mlkit.config import load_config
    from mlkit.runs import latest_run_dir

    parser = argparse.ArgumentParser(description="Show a run's status file.")
    parser.add_argument("target", nargs="?", help="a status.json path or a run directory")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--stale-after", type=float, default=300.0, help="seconds")
    args = parser.parse_args(argv)

    if args.target:
        p = Path(args.target)
        path = p / "status.json" if p.is_dir() else p
    else:
        run = latest_run_dir(load_config())
        if run is None:
            print("no runs yet: uv run train", file=sys.stderr)
            return 1
        path = run / "status.json"
    if not path.exists():
        print(f"no status file at {path}", file=sys.stderr)
        return 1
    s = read_status(path, args.stale_after)
    if args.json:
        print(json.dumps(s))
        return 0
    state = s["status"] + (" (STALE: no heartbeat, process gone?)" if s["stale"] else "")
    progress = f"{s['step']}/{s['total_steps']}" if s.get("total_steps") else str(s["step"])
    print(f"{s['run_id']}: {state}  step {progress}  updated {s['age_seconds']}s ago")
    if s.get("metrics"):
        print("  " + "  ".join(f"{k}={v:.4g}" for k, v in s["metrics"].items()))
    if s.get("eta_seconds"):
        print(f"  eta {s['eta_seconds']}s")
    for err in s.get("errors", []):
        print(f"  error: {err}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
