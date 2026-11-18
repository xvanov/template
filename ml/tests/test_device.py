import json

import pytest

from mlkit import device
from mlkit.device import DeviceInfo, detect, require_device


def test_prefer_cpu_never_probes() -> None:
    info = detect("cpu")
    assert info.kind == "cpu" and not info.is_gpu


def test_no_torch_and_a_broken_driver_is_cpu_with_the_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # What a kernel update without a reboot looks like.
    monkeypatch.setattr(device, "_torch", lambda: None)
    monkeypatch.setattr(
        device,
        "_nvidia_smi",
        lambda: (None, "nvidia-smi failed: Failed to initialize NVML: Driver/library version"),
    )
    info = detect()
    assert info.kind == "cpu"
    assert "Driver/library version" in info.reason


def test_gpu_visible_but_no_torch_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(device, "_torch", lambda: None)
    monkeypatch.setattr(device, "_nvidia_smi", lambda: ("NVIDIA L4, 23034, 22000", None))
    info = detect()
    assert info.kind == "cpu"
    assert "torch is not installed" in info.reason
    assert info.nvidia_smi == "NVIDIA L4, 23034, 22000"


def test_a_torch_that_throws_is_cpu_not_a_crash(monkeypatch: pytest.MonkeyPatch) -> None:
    class Boom:
        __version__ = "9.9"

        class cuda:
            @staticmethod
            def is_available() -> bool:
                raise RuntimeError("CUDA driver initialization failed")

        class backends:
            mps = None

    monkeypatch.setattr(device, "_torch", lambda: Boom)
    monkeypatch.setattr(device, "_nvidia_smi", lambda: (None, None))
    info = detect()
    assert info.kind == "cpu"
    assert "CUDA driver initialization failed" in info.reason


def test_require_gpu_refuses_with_a_message_not_a_traceback() -> None:
    cpu = DeviceInfo(kind="cpu", name="cpu", reason="no GPU")
    require_device(cpu, require_gpu=False)  # fine
    with pytest.raises(SystemExit, match="require_gpu is true"):
        require_device(cpu, require_gpu=True)


def test_min_free_memory() -> None:
    gpu = DeviceInfo("cuda", "L4", memory_total_gb=24, memory_free_gb=2.0)
    with pytest.raises(SystemExit, match=r"only 2\.0 GB"):
        require_device(gpu, require_gpu=True, min_gpu_memory_gb=8)


def test_cli_json(capsys: pytest.CaptureFixture[str]) -> None:
    assert device.main(["--prefer", "cpu", "--json"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["kind"] == "cpu" and data["is_gpu"] is False
