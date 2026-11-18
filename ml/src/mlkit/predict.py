"""Score items with the latest trained model. JSON in on stdin, JSON out on stdout.

This is the contract the worker's ``ml.predict`` job speaks
(packages/jobs/src/ml.ts); ml/contract/predict.example.json is an example of
both sides and is checked by tests in BOTH languages.

    echo '{"items":[{"id":"1","title":"roof leak today"}]}' | uv run predict

Request:  {"items": [{"id": str, "title": str, "notes": str | null}, ...]}  (<= 1000)
Response: {"ok": true, "model": {"run_id": str, "kind": str},
           "predictions": [{"id": str, "score": float, "urgent": bool}, ...]}
Expected failures (no model yet, bad input) are {"ok": false, "reason": str}
with exit code 0: the caller shows the reason. Anything else is a crash:
exit code 1 and a traceback on stderr. stdout carries ONLY the JSON answer;
logs go to stderr.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from mlkit.config import load_config
from mlkit.runs import latest_run_dir
from mlkit.toy import Model

MAX_ITEMS = 1000
MAX_TEXT = 2000


class BadRequestError(ValueError):
    pass


def parse_request(data: Any) -> list[dict[str, str]]:
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise BadRequestError('expected {"items": [...]}')
    items = data["items"]
    if len(items) > MAX_ITEMS:
        raise BadRequestError(f"at most {MAX_ITEMS} items per call, got {len(items)}")
    out = []
    for n, it in enumerate(items):
        if not isinstance(it, dict) or not isinstance(it.get("id"), str):
            raise BadRequestError(f"items[{n}] needs a string id")
        title = it.get("title")
        notes = it.get("notes")
        if not isinstance(title, str) or (notes is not None and not isinstance(notes, str)):
            raise BadRequestError(f"items[{n}] needs a string title (notes: string or null)")
        text = f"{title} {notes or ''}".strip()[:MAX_TEXT]
        out.append({"id": it["id"], "text": text})
    return out


def predict(data: Any, model_path: Path | None = None) -> dict[str, Any]:
    try:
        items = parse_request(data)
    except BadRequestError as e:
        return {"ok": False, "reason": f"bad request: {e}"}
    if model_path is None:
        run = latest_run_dir(load_config())
        if run is None:
            return {"ok": False, "reason": "no trained model yet: run `cd ml && uv run train`"}
        model_path = run / "model.json"
    if not model_path.exists():
        return {"ok": False, "reason": f"model file missing: {model_path}"}
    model = Model.load(model_path)
    proba = model.predict_proba([i["text"] for i in items]) if items else []
    return {
        "ok": True,
        "model": {"run_id": model_path.parent.name, "kind": "toy-logreg"},
        "predictions": [
            {"id": i["id"], "score": round(float(p), 4), "urgent": bool(p >= model.threshold)}
            for i, p in zip(items, proba, strict=True)
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Score items: JSON on stdin -> JSON on stdout.")
    parser.add_argument("--model", help="a model.json path (default: runs/LATEST)")
    args = parser.parse_args(argv)
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        result: dict[str, Any] = {"ok": False, "reason": f"bad request: not JSON ({e})"}
    else:
        result = predict(data, Path(args.model) if args.model else None)
    sys.stdout.write(json.dumps(result) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
