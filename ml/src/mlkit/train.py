"""Train and evaluate the toy model. Runs on a CPU in about a second.

    uv run train                                  # config/default.toml
    uv run train --set train.epochs=50            # one-off override
    uv run train --exp EXP-001                    # the experiment's config.toml;
                                                  # metrics land in its folder too
    uv run train --resplit                        # write a NEW split, on purpose

Every run gets ``runs/<run_id>/`` with config.json, split info, status.json
(live while it runs), metrics.json and model.json; ``runs/LATEST`` points at
the newest completed run, which is what ``uv run predict`` (and the worker's
``ml.predict`` job) loads.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

from mlkit import split as splits
from mlkit import toy
from mlkit.config import Config, ConfigError, load_config
from mlkit.device import detect, require_device
from mlkit.experiments import ExperimentError, find_experiment, record_metrics
from mlkit.runs import mark_latest, new_run_id, run_dir
from mlkit.status import RunStatus, write_atomic


def git_state() -> dict[str, Any]:
    """Commit + dirty flag, so a metric can be traced to the code that produced it."""
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=5, check=True
        ).stdout.strip()
        dirty = bool(
            subprocess.run(
                ["git", "status", "--porcelain"], capture_output=True, text=True, timeout=5
            ).stdout.strip()
        )
        return {"commit": commit, "dirty": dirty}
    except (OSError, subprocess.SubprocessError):
        return {"commit": None, "dirty": None}


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    try:
        import torch  # type: ignore[import-not-found]

        torch.manual_seed(seed)
    except Exception:
        pass


def train(
    cfg: Config, run_id: str, resplit: bool = False, heartbeat_seconds: float = 30.0
) -> dict[str, Any]:
    """One full run. Returns the metrics dict that is also written to disk."""
    seed_everything(cfg.seed)
    device = detect(cfg.device.prefer)
    require_device(device, cfg.device.require_gpu, cfg.device.min_gpu_memory_gb)
    print(f"[train] {run_id} on {device.describe()}", file=sys.stderr)

    out = run_dir(cfg, run_id)
    out.mkdir(parents=True, exist_ok=False)
    config_json = json.dumps(cfg.to_dict(), indent=2, sort_keys=True)
    (out / "config.json").write_text(config_json + "\n")

    with RunStatus(
        out / "status.json",
        run_id=run_id,
        total_steps=cfg.train.epochs,
        heartbeat_seconds=heartbeat_seconds,
        device=device.describe(),
    ) as status:
        if cfg.data.dataset != "toy":
            raise ConfigError(f"unknown dataset {cfg.data.dataset!r} (this template ships 'toy')")
        rows = toy.make_dataset(cfg.data.n_samples, cfg.seed)
        by_id = {r.id: r for r in rows}
        split, created = splits.load_or_create(
            cfg.resolve(cfg.data.split_file),
            by_id.keys(),
            cfg.data.val_fraction,
            cfg.seed,
            resplit=resplit,
        )
        if created:
            print(f"[train] wrote a NEW split: {cfg.data.split_file}", file=sys.stderr)
        tr = [by_id[i] for i in split.train]
        va = [by_id[i] for i in split.val]
        x_tr = toy.featurize([r.text for r in tr], cfg.train.features)
        y_tr = np.array([r.label for r in tr], dtype=np.float64)

        t0 = time.monotonic()

        def on_epoch(epoch: int, loss: float) -> None:
            if epoch % cfg.train.status_every == 0 or epoch == cfg.train.epochs:
                status.update(step=epoch, metrics={"train_loss": loss})

        w, b = toy.fit(
            x_tr, y_tr, cfg.train.epochs, cfg.train.learning_rate, cfg.train.l2, on_epoch
        )
        model = toy.Model(w, b, cfg.train.features)
        model.save(out / "model.json")

        result = {
            "run_id": run_id,
            "seconds": round(time.monotonic() - t0, 3),
            "train": toy.metrics(y_tr, model.predict_proba([r.text for r in tr])),
            "val": toy.metrics(
                np.array([r.label for r in va]), model.predict_proba([r.text for r in va])
            ),
            "split": {
                "file": cfg.data.split_file,
                "ids_sha256": split.ids_sha256,
                "n_train": len(split.train),
                "n_val": len(split.val),
            },
            "config_sha256": hashlib.sha256(config_json.encode()).hexdigest(),
            "device": device.kind,
            "git": git_state(),
        }
        write_atomic(out / "metrics.json", result)
        status.update(metrics={f"val_{k}": v for k, v in result["val"].items() if k != "n"})
    mark_latest(cfg, run_id)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Train + evaluate the toy model.")
    parser.add_argument("--config", help="TOML config (default: config/default.toml)")
    parser.add_argument(
        "--exp", help="experiment id (EXP-001): use its config.toml, record metrics"
    )
    parser.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")
    parser.add_argument("--run-id", help="default: run-<utc time>-<random>")
    parser.add_argument("--resplit", action="store_true", help="write a new train/val split")
    args = parser.parse_args(argv)

    try:
        exp_dir: Path | None = None
        config_path = args.config
        if args.exp:
            exp_dir = find_experiment(args.exp)
            config_path = config_path or str(exp_dir / "config.toml")
        cfg = load_config(config_path, overrides=args.set)
        run_id = args.run_id or new_run_id(args.exp.lower() if args.exp else "run")
        result = train(cfg, run_id, resplit=args.resplit)
    except (ConfigError, ExperimentError, splits.SplitMismatchError) as e:
        print(f"[train] {e}", file=sys.stderr)
        return 2

    if exp_dir is not None:
        record_metrics(exp_dir, result)
    v = result["val"]
    print(
        f"[train] {run_id}: val accuracy={v['accuracy']:.3f} f1={v['f1']:.3f} "
        f"logloss={v['logloss']:.3f} ({result['seconds']}s)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
