from pathlib import Path

import pytest

from mlkit.config import Config, ConfigError, env_overrides, load_config


def test_defaults_match_default_toml(ml_home: Path) -> None:
    # config/default.toml documents the defaults; they must not drift apart.
    assert load_config().to_dict() == Config().to_dict()


def test_precedence_file_then_env_then_set(tmp_path: Path) -> None:
    f = tmp_path / "c.toml"
    f.write_text("seed = 1\n[train]\nepochs = 10\nlearning_rate = 0.1\n")
    env = {"ML__TRAIN__EPOCHS": "20", "ML__SEED": "2", "OTHER": "x"}
    cfg = load_config(f, overrides=["train.epochs=30"], environ=env)
    assert cfg.seed == 2  # env beats file
    assert cfg.train.epochs == 30  # --set beats env
    assert cfg.train.learning_rate == 0.1  # file beats default


def test_env_keys_keep_single_underscores() -> None:
    assert env_overrides({"ML__TRAIN__LEARNING_RATE": "0.2"}) == {"train.learning_rate": "0.2"}


def test_types_are_coerced(tmp_path: Path) -> None:
    cfg = load_config(
        None,
        overrides=["device.require_gpu=yes", "train.l2=1e-4", "data.n_samples=50"],
        environ={},
    )
    assert cfg.device.require_gpu is True
    assert cfg.train.l2 == pytest.approx(1e-4)
    assert cfg.data.n_samples == 50


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ("train.epoch=5", "unknown config key 'train.epoch'"),
        ("train.epochs=five", "expected an integer"),
        ("device.require_gpu=maybe", "expected true/false"),
        ("train=5", "is a section"),
        ("seed.x=1", "is a value, not a section"),
        ("noequals", "section.key=value"),
        ("data.val_fraction=1.5", "between 0 and 1"),
        ("device.prefer=tpu", "auto|cuda|mps|cpu"),
    ],
)
def test_bad_values_fail_with_a_readable_message(override: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message.replace("|", r"\|").replace(".", r"\.")):
        load_config(None, overrides=[override], environ={})


def test_unknown_key_in_file_is_an_error(tmp_path: Path) -> None:
    f = tmp_path / "c.toml"
    f.write_text("[train]\nepohcs = 3\n")
    with pytest.raises(ConfigError, match=r"unknown config key 'train\.epohcs'"):
        load_config(f, environ={})


def test_missing_file_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="not found"):
        load_config(tmp_path / "nope.toml", environ={})


def test_relative_paths_resolve_against_ml_root(ml_home: Path) -> None:
    cfg = load_config()
    assert cfg.resolve("runs") == ml_home / "runs"
    assert cfg.resolve("/abs/x") == Path("/abs/x")
