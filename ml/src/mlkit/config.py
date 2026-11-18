"""Typed configuration: dataclass defaults < TOML file < env vars < --set overrides.

    cfg = load_config("config/default.toml", overrides=["train.epochs=50"])

Env overrides use a double underscore between parts, so keys with single
underscores still work: ``ML__TRAIN__LEARNING_RATE=0.1``, ``ML__SEED=7``.

Unknown keys are errors, everywhere. A typo in a config file that is silently
ignored runs the experiment you did not mean to run.
"""

from __future__ import annotations

import dataclasses
import os
import tomllib
import types
import typing
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from mlkit.paths import ml_root

ENV_PREFIX = "ML__"


class ConfigError(ValueError):
    """A config value or key that cannot be used. The message says which and why."""


@dataclass
class DataConfig:
    dataset: str = "toy"
    n_samples: int = 600
    val_fraction: float = 0.2
    split_file: str = "splits/toy.json"


@dataclass
class TrainConfig:
    epochs: int = 300
    learning_rate: float = 3.0
    l2: float = 0.001
    features: int = 4096
    status_every: int = 25


@dataclass
class DeviceConfig:
    prefer: str = "auto"
    require_gpu: bool = False
    min_gpu_memory_gb: float = 0.0


@dataclass
class PathsConfig:
    runs: str = "runs"
    data: str = "data"


@dataclass
class Config:
    seed: int = 42
    data: DataConfig = field(default_factory=DataConfig)
    train: TrainConfig = field(default_factory=TrainConfig)
    device: DeviceConfig = field(default_factory=DeviceConfig)
    paths: PathsConfig = field(default_factory=PathsConfig)

    def resolve(self, relative: str) -> Path:
        """A configured path, resolved against ml/ (not the caller's cwd)."""
        p = Path(relative)
        return p if p.is_absolute() else ml_root() / p

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


def _field_types(cls: type) -> dict[str, Any]:
    return typing.get_type_hints(cls)


def _coerce(value: Any, typ: Any, key: str) -> Any:
    """Turn a TOML value or an env/CLI string into the declared type, or fail clearly."""
    if isinstance(typ, types.UnionType):  # e.g. `str | None`
        args = [a for a in typ.__args__ if a is not type(None)]
        if value is None or (isinstance(value, str) and value.lower() in ("", "none", "null")):
            return None
        typ = args[0]
    if typ is bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.lower() in ("true", "1", "yes", "on"):
            return True
        if isinstance(value, str) and value.lower() in ("false", "0", "no", "off"):
            return False
        raise ConfigError(f"{key}: expected true/false, got {value!r}")
    if typ is int:
        if isinstance(value, bool):
            raise ConfigError(f"{key}: expected an integer, got {value!r}")
        try:
            return int(value)
        except (TypeError, ValueError):
            raise ConfigError(f"{key}: expected an integer, got {value!r}") from None
    if typ is float:
        if isinstance(value, bool):
            raise ConfigError(f"{key}: expected a number, got {value!r}")
        try:
            return float(value)
        except (TypeError, ValueError):
            raise ConfigError(f"{key}: expected a number, got {value!r}") from None
    if typ is str:
        if not isinstance(value, str | int | float):
            raise ConfigError(f"{key}: expected a string, got {value!r}")
        return str(value)
    raise ConfigError(f"{key}: unsupported type {typ!r}")


def _set(cfg: Config, dotted: str, raw: Any) -> None:
    parts = dotted.split(".")
    target: Any = cfg
    for i, part in enumerate(parts):
        hints = _field_types(type(target))
        if part not in hints:
            known = ", ".join(sorted(hints))
            where = ".".join(parts[:i]) or "top level"
            raise ConfigError(f"unknown config key {dotted!r} ({where} has: {known})")
        if i == len(parts) - 1:
            if dataclasses.is_dataclass(hints[part]):
                raise ConfigError(f"{dotted} is a section; set one of its keys instead")
            setattr(target, part, _coerce(raw, hints[part], dotted))
        else:
            if not dataclasses.is_dataclass(hints[part]):
                raise ConfigError(f"{'.'.join(parts[: i + 1])} is a value, not a section")
            target = getattr(target, part)


def _apply_mapping(cfg: Config, data: dict[str, Any], prefix: str = "") -> None:
    for key, value in data.items():
        dotted = f"{prefix}{key}"
        if isinstance(value, dict):
            _apply_mapping(cfg, value, f"{dotted}.")
        else:
            _set(cfg, dotted, value)


def env_overrides(environ: dict[str, str] | None = None) -> dict[str, str]:
    """``ML__TRAIN__EPOCHS=5`` -> ``{"train.epochs": "5"}``."""
    environ = dict(os.environ) if environ is None else environ
    out: dict[str, str] = {}
    for name, value in environ.items():
        if name.startswith(ENV_PREFIX) and len(name) > len(ENV_PREFIX):
            out[name[len(ENV_PREFIX) :].lower().replace("__", ".")] = value
    return out


def load_config(
    path: str | Path | None = None,
    overrides: list[str] | None = None,
    environ: dict[str, str] | None = None,
) -> Config:
    """Build the config. ``path`` None = config/default.toml if it exists, else defaults."""
    cfg = Config()
    if path is None:
        default = ml_root() / "config" / "default.toml"
        path = default if default.exists() else None
    if path is not None:
        p = Path(path)
        if not p.exists():
            raise ConfigError(f"config file not found: {p}")
        with p.open("rb") as f:
            try:
                data = tomllib.load(f)
            except tomllib.TOMLDecodeError as e:
                raise ConfigError(f"{p}: {e}") from None
        _apply_mapping(cfg, data)
    for dotted, value in env_overrides(environ).items():
        _set(cfg, dotted, value)
    for item in overrides or []:
        if "=" not in item:
            raise ConfigError(f"--set expects section.key=value, got {item!r}")
        dotted, value = item.split("=", 1)
        _set(cfg, dotted.strip(), value.strip())
    validate(cfg)
    return cfg


def validate(cfg: Config) -> None:
    if not 0 < cfg.data.val_fraction < 1:
        raise ConfigError(f"data.val_fraction must be between 0 and 1, got {cfg.data.val_fraction}")
    if cfg.data.n_samples < 10:
        raise ConfigError(f"data.n_samples must be at least 10, got {cfg.data.n_samples}")
    if cfg.train.epochs < 1:
        raise ConfigError(f"train.epochs must be at least 1, got {cfg.train.epochs}")
    if cfg.train.features < 8:
        raise ConfigError(f"train.features must be at least 8, got {cfg.train.features}")
    if cfg.device.prefer not in ("auto", "cuda", "mps", "cpu"):
        raise ConfigError(f"device.prefer must be auto|cuda|mps|cpu, got {cfg.device.prefer!r}")
