"""Which device will this run on? CUDA, Apple MPS, or CPU, and why.

Never raises: a box without a GPU, without torch, or with a broken driver
(``nvidia-smi`` says "Driver/library version mismatch" after a kernel update)
gets ``kind="cpu"`` and a ``reason`` that says what happened. Only
``require_device`` refuses, and it refuses with a message, not a traceback.

    uv run device          # human-readable
    uv run device --json   # for scripts (and scripts/doctor.sh)
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Any


@dataclass
class DeviceInfo:
    kind: str  # "cuda" | "mps" | "cpu"
    name: str
    memory_total_gb: float | None = None
    memory_free_gb: float | None = None
    torch_version: str | None = None
    # Empty when a GPU was picked; otherwise why not (no torch, no driver, ...).
    reason: str = ""
    # What nvidia-smi said, when torch is absent or could not use the GPU.
    nvidia_smi: str | None = None

    @property
    def is_gpu(self) -> bool:
        return self.kind in ("cuda", "mps")

    def describe(self) -> str:
        if self.kind == "cuda":
            mem = ""
            if self.memory_total_gb is not None:
                free = f"{self.memory_free_gb:.1f}" if self.memory_free_gb is not None else "?"
                mem = f", {free}/{self.memory_total_gb:.1f} GB free"
            return f"GPU: CUDA {self.name}{mem} (torch {self.torch_version})"
        if self.kind == "mps":
            return f"GPU: Apple MPS {self.name} (torch {self.torch_version})"
        why = f" ({self.reason})" if self.reason else ""
        return f"CPU only{why}"


def _nvidia_smi() -> tuple[str | None, str | None]:
    """(first GPU "name, total MiB, free MiB", error). Both None = no nvidia-smi at all."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None, None
    try:
        out = subprocess.run(
            [exe, "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, f"nvidia-smi failed: {e}"
    if out.returncode != 0:
        msg = (out.stdout + out.stderr).strip().splitlines()
        return None, f"nvidia-smi failed: {msg[0] if msg else f'exit {out.returncode}'}"
    lines = out.stdout.strip().splitlines()
    return (lines[0].strip() if lines else None), None


def _torch() -> Any | None:
    try:
        import torch  # type: ignore[import-not-found]
    except Exception:  # not installed, or a broken install: either way, no torch
        return None
    return torch


def detect(prefer: str = "auto") -> DeviceInfo:
    """Pick the best device allowed by ``prefer`` (auto | cuda | mps | cpu)."""
    if prefer == "cpu":
        return DeviceInfo(kind="cpu", name="cpu", reason="device.prefer = cpu")

    torch = _torch()
    if torch is None:
        smi, err = _nvidia_smi()
        if smi:
            reason = "torch is not installed, so the GPU is unused (uv add torch)"
            return DeviceInfo(kind="cpu", name="cpu", reason=reason, nvidia_smi=smi)
        return DeviceInfo(
            kind="cpu",
            name="cpu",
            reason=err or "torch is not installed and no NVIDIA GPU is visible",
            nvidia_smi=err,
        )

    version = getattr(torch, "__version__", "?")
    reasons: list[str] = []
    if prefer in ("auto", "cuda"):
        try:
            if torch.cuda.is_available():
                props = torch.cuda.get_device_properties(0)
                total = props.total_memory / 1024**3
                free = None
                try:
                    free_b, _ = torch.cuda.mem_get_info(0)
                    free = free_b / 1024**3
                except Exception:
                    pass
                # A real allocation: is_available() can be True on a GPU that then fails.
                torch.zeros(1, device="cuda:0")
                return DeviceInfo("cuda", props.name, total, free, version)
            reasons.append("torch sees no CUDA device")
        except Exception as e:
            reasons.append(f"CUDA error: {e}".splitlines()[0])
    if prefer in ("auto", "mps"):
        try:
            mps = getattr(torch.backends, "mps", None)
            if mps is not None and mps.is_available():
                torch.zeros(1, device="mps")
                return DeviceInfo("mps", "Apple Silicon", torch_version=version)
            if prefer == "mps":
                reasons.append("MPS is not available")
        except Exception as e:
            reasons.append(f"MPS error: {e}".splitlines()[0])
    smi, err = _nvidia_smi()
    return DeviceInfo(
        kind="cpu",
        name="cpu",
        torch_version=version,
        reason="; ".join(reasons) or "no GPU",
        nvidia_smi=smi or err,
    )


class DeviceRequirementError(SystemExit):
    """Raised by require_device: exits with the message, no traceback."""


def require_device(info: DeviceInfo, require_gpu: bool, min_gpu_memory_gb: float = 0.0) -> None:
    if require_gpu and not info.is_gpu:
        raise DeviceRequirementError(
            f"device.require_gpu is true but this run would use the CPU: {info.reason}. "
            "Run on a GPU box, or set ML__DEVICE__REQUIRE_GPU=false."
        )
    if (
        info.kind == "cuda"
        and min_gpu_memory_gb > 0
        and info.memory_free_gb is not None
        and info.memory_free_gb < min_gpu_memory_gb
    ):
        raise DeviceRequirementError(
            f"only {info.memory_free_gb:.1f} GB of GPU memory is free; "
            f"device.min_gpu_memory_gb is {min_gpu_memory_gb}. Is another job using the GPU?"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Report the device training would use.")
    parser.add_argument("--prefer", default="auto", choices=["auto", "cuda", "mps", "cpu"])
    parser.add_argument("--json", action="store_true", help="print JSON")
    args = parser.parse_args(argv)
    info = detect(args.prefer)
    if args.json:
        print(json.dumps({**dataclasses.asdict(info), "is_gpu": info.is_gpu}))
    else:
        print(info.describe())
        if info.nvidia_smi and not info.is_gpu and info.nvidia_smi not in info.reason:
            print(f"  nvidia-smi: {info.nvidia_smi}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
