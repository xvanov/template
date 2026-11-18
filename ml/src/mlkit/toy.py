"""The toy problem: is a to-do item urgent? Small enough to train on a CPU in
well under a second, shaped like the app's data (an Item has a title and
notes) so the worker bridge has something real to call.

Replace this module with your problem. Keep the shape: a dataset of
``(id, text, label)`` rows, a model that saves to and loads from one file.
"""

from __future__ import annotations

import itertools
import json
import random
import re
import zlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np

URGENT = ["urgent", "asap", "broken", "outage", "today", "overdue", "leak", "down", "fix", "now"]
CALM = ["someday", "idea", "maybe", "read", "later", "explore", "draft", "nice", "plan", "review"]
NOUNS = [
    "invoice", "server", "roof", "report", "client call", "boiler", "website", "contract",
    "laptop", "payroll", "garden", "newsletter", "van", "backup", "kitchen", "pitch deck",
]  # fmt: skip


@dataclass(frozen=True)
class Row:
    id: str
    text: str
    label: int  # 1 = urgent


def make_dataset(n: int, seed: int, noise: float = 0.05) -> list[Row]:
    """Deterministic for (n, seed): the same rows on every machine and Python."""
    rng = random.Random(seed)
    rows = []
    for i in range(n):
        label = rng.random() < 0.4
        cue = rng.choice(URGENT if label else CALM)
        words = [cue, rng.choice(NOUNS)]
        if rng.random() < 0.5:
            words.append(rng.choice(NOUNS))
        if rng.random() < 0.3:  # a weak cue from the other side: not every row is easy
            words.append(rng.choice(CALM if label else URGENT))
        rng.shuffle(words)
        if rng.random() < noise:
            label = not label
        rows.append(Row(id=f"toy-{i:05d}", text=" ".join(words), label=int(label)))
    return rows


_TOKEN = re.compile(r"[a-z0-9]+")


def featurize(texts: list[str], dim: int) -> np.ndarray:
    """Hashed word + bigram presence (0/1). crc32, not hash(): stable across runs.

    Not normalised by length on purpose: a word the model never saw lands in a
    bucket whose weight is ~0, so a long note does not dilute "leak, fix today".
    """
    x = np.zeros((len(texts), dim), dtype=np.float64)
    for r, text in enumerate(texts):
        toks = _TOKEN.findall(text.lower())
        grams = toks + [f"{a}_{b}" for a, b in itertools.pairwise(toks)]
        for g in grams:
            x[r, zlib.crc32(g.encode()) % dim] = 1.0
    return x


def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))


@dataclass
class Model:
    weights: np.ndarray
    bias: float
    features: int
    threshold: float = 0.5

    def predict_proba(self, texts: list[str]) -> np.ndarray:
        return _sigmoid(featurize(texts, self.features) @ self.weights + self.bias)

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "kind": "toy-logreg",
                    "features": self.features,
                    "threshold": self.threshold,
                    "bias": self.bias,
                    "weights": [round(float(w), 8) for w in self.weights],
                }
            )
        )

    @classmethod
    def load(cls, path: Path) -> Model:
        d = json.loads(path.read_text())
        if d.get("kind") != "toy-logreg":
            raise ValueError(f"{path} is not a toy-logreg model")
        return cls(np.array(d["weights"]), float(d["bias"]), int(d["features"]), d["threshold"])


def fit(
    x: np.ndarray,
    y: np.ndarray,
    epochs: int,
    lr: float,
    l2: float,
    on_epoch=None,
) -> tuple[np.ndarray, float]:
    """Full-batch gradient descent on logistic loss. Deterministic: zero init, no shuffling."""
    n, d = x.shape
    w = np.zeros(d)
    b = 0.0
    for epoch in range(epochs):
        p = _sigmoid(x @ w + b)
        grad = p - y
        w -= lr * (x.T @ grad / n + l2 * w)
        b -= lr * float(grad.mean())
        if on_epoch is not None:
            eps = 1e-12
            loss = float(-np.mean(y * np.log(p + eps) + (1 - y) * np.log(1 - p + eps)))
            on_epoch(epoch + 1, loss)
    return w, b


def metrics(y_true: np.ndarray, proba: np.ndarray, threshold: float = 0.5) -> dict[str, float]:
    pred = (proba >= threshold).astype(int)
    tp = int(((pred == 1) & (y_true == 1)).sum())
    fp = int(((pred == 1) & (y_true == 0)).sum())
    fn = int(((pred == 0) & (y_true == 1)).sum())
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    eps = 1e-12
    logloss = float(-np.mean(y_true * np.log(proba + eps) + (1 - y_true) * np.log(1 - proba + eps)))
    return {
        "accuracy": float((pred == y_true).mean()),
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "logloss": logloss,
        "n": float(len(y_true)),
    }
