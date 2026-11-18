"""The experiment protocol: one hypothesis per experiment, one registry.

    uv run exp new "Bigrams help" --hypothesis "Adding bigrams raises val F1 by 2+ points"
    uv run exp list
    uv run exp set EXP-002 VALIDATED --result "F1 0.91 -> 0.94 (run exp-002-...)"
    uv run train --exp EXP-002          # runs with the experiment's config.toml

``new`` copies experiments/_template/ to experiments/EXP-<n>-<slug>/ (README
with hypothesis / setup / results / conclusion, a snapshot of the current
config, an empty metrics.json) and adds a row to experiments/REGISTRY.md.
Before starting anything, read the registry: it is how you find out that an
idea was already tried, and why it failed.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from mlkit.fsutil import write_text_atomic
from mlkit.paths import ml_root
from mlkit.status import write_atomic

STATUSES = ("PLANNED", "RUNNING", "VALIDATED", "INVALIDATED", "INCONCLUSIVE", "ABANDONED")
HEADER = "| ID | Title | Status | Hypothesis | Result | Folder |"
_ID = re.compile(r"^EXP-(\d{3,})$")
_CELL_SPLIT = re.compile(r"(?<!\\)\|")


class ExperimentError(RuntimeError):
    pass


@dataclass
class Entry:
    id: str
    title: str
    status: str
    hypothesis: str
    result: str
    folder: str

    def row(self) -> str:
        cells = [self.id, self.title, self.status, self.hypothesis, self.result, self.folder]
        return "| " + " | ".join(_escape(c) for c in cells) + " |"


def _escape(s: str) -> str:
    return " ".join(s.split()).replace("|", "\\|")


def _unescape(s: str) -> str:
    return s.strip().replace("\\|", "|")


def experiments_dir() -> Path:
    return ml_root() / "experiments"


def registry_path(root: Path) -> Path:
    return root / "REGISTRY.md"


def slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug[:40].rstrip("-") or "experiment"


def _read_registry(root: Path) -> tuple[list[str], list[Entry], int]:
    """(all lines, entries, index of the header line)."""
    path = registry_path(root)
    if not path.exists():
        raise ExperimentError(f"no registry at {path}")
    lines = path.read_text().splitlines()
    try:
        header_at = next(i for i, line in enumerate(lines) if line.strip() == HEADER)
    except StopIteration:
        raise ExperimentError(f"{path}: the table header line is missing:\n  {HEADER}") from None
    entries = []
    for line in lines[header_at + 2 :]:
        if not line.startswith("| EXP-"):
            if line.strip() == "":
                break
            continue
        cells = [_unescape(c) for c in _CELL_SPLIT.split(line.strip())[1:-1]]
        if len(cells) != 6:
            raise ExperimentError(f"{path}: malformed row (expected 6 cells): {line}")
        entries.append(Entry(*cells))
    return lines, entries, header_at


def list_experiments(root: Path | None = None) -> list[Entry]:
    return _read_registry(root or experiments_dir())[1]


def _write_registry(root: Path, lines: list[str], entries: list[Entry], header_at: int) -> None:
    # Rows are everything between the separator and the first blank line after it.
    end = header_at + 2
    while end < len(lines) and lines[end].strip() != "":
        end += 1
    new_lines = lines[: header_at + 2] + [e.row() for e in entries] + lines[end:]
    write_text_atomic(registry_path(root), "\n".join(new_lines) + "\n")


def next_id(root: Path, entries: list[Entry]) -> str:
    nums = [int(m.group(1)) for e in entries if (m := _ID.match(e.id))]
    for p in root.glob("EXP-*"):
        m = re.match(r"^EXP-(\d{3,})", p.name)
        if m:
            nums.append(int(m.group(1)))
    return f"EXP-{max(nums, default=0) + 1:03d}"


def new_experiment(
    title: str,
    hypothesis: str = "",
    root: Path | None = None,
    base_config: Path | None = None,
) -> tuple[str, Path]:
    root = root or experiments_dir()
    title = title.strip()
    if not title:
        raise ExperimentError("an experiment needs a title")
    template = root / "_template"
    if not template.is_dir():
        raise ExperimentError(f"missing template folder {template}")
    lines, entries, header_at = _read_registry(root)
    exp_id = next_id(root, entries)
    folder = root / f"{exp_id}-{slugify(title)}"
    shutil.copytree(template, folder)
    # The config is a SNAPSHOT: later edits to config/default.toml must not
    # change what an old experiment meant.
    base = base_config or (ml_root() / "config" / "default.toml")
    if base.exists():
        shutil.copyfile(base, folder / "config.toml")
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    readme = folder / "README.md"
    readme.write_text(
        readme.read_text()
        .replace("{{id}}", exp_id)
        .replace("{{title}}", title)
        .replace("{{date}}", today)
        .replace("{{hypothesis}}", hypothesis.strip() or "TODO: one falsifiable sentence.")
    )
    entries.append(
        Entry(exp_id, title, "PLANNED", hypothesis.strip() or "TODO", "", f"{folder.name}/")
    )
    _write_registry(root, lines, entries, header_at)
    return exp_id, folder


def find_experiment(exp_id: str, root: Path | None = None) -> Path:
    root = root or experiments_dir()
    exp_id = exp_id.upper()
    if not _ID.match(exp_id):
        raise ExperimentError(f"not an experiment id: {exp_id!r} (expected EXP-001)")
    matches = sorted(p for p in root.glob(f"{exp_id}-*") if p.is_dir())
    if (root / exp_id).is_dir():
        matches.insert(0, root / exp_id)
    if not matches:
        raise ExperimentError(f"no folder for {exp_id} in {root} (uv run exp list)")
    return matches[0]


def set_status(
    exp_id: str, status: str, result: str | None = None, root: Path | None = None
) -> Entry:
    root = root or experiments_dir()
    status = status.upper()
    if status not in STATUSES:
        raise ExperimentError(f"status must be one of {', '.join(STATUSES)}")
    lines, entries, header_at = _read_registry(root)
    for e in entries:
        if e.id == exp_id.upper():
            e.status = status
            if result is not None:
                e.result = result
            _write_registry(root, lines, entries, header_at)
            readme = root / e.folder.rstrip("/") / "README.md"
            if readme.exists():
                write_text_atomic(
                    readme,
                    re.sub(
                        r"^\*\*Status:\*\* .*$",
                        f"**Status:** {status}",
                        readme.read_text(),
                        count=1,
                        flags=re.M,
                    ),
                )
            return e
    raise ExperimentError(f"{exp_id} is not in the registry")


def record_metrics(exp_dir: Path, result: dict[str, Any]) -> None:
    """Append a run's summary to the experiment's metrics.json (latest run in full)."""
    path = exp_dir / "metrics.json"
    data: dict[str, Any] = {}
    if path.exists() and path.read_text().strip():
        data = json.loads(path.read_text())
    runs = data.get("runs", [])
    runs.append(
        {
            "run_id": result.get("run_id"),
            "val": result.get("val"),
            "git": result.get("git"),
            "recorded_at": datetime.now(UTC).isoformat(timespec="seconds"),
        }
    )
    write_atomic(path, {"latest": result, "runs": runs})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="exp", description="The experiment registry.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_new = sub.add_parser("new", help="scaffold the next EXP folder and register it")
    p_new.add_argument("title")
    p_new.add_argument("--hypothesis", default="")
    sub.add_parser("list", help="print the registry")
    p_set = sub.add_parser("set", help="change an experiment's status (and result)")
    p_set.add_argument("id")
    p_set.add_argument("status", choices=[s for s in STATUSES] + [s.lower() for s in STATUSES])
    p_set.add_argument("--result")
    args = parser.parse_args(argv)

    try:
        if args.cmd == "new":
            exp_id, folder = new_experiment(args.title, args.hypothesis)
            rel = folder.relative_to(ml_root()) if folder.is_relative_to(ml_root()) else folder
            print(f"{exp_id}: {rel}/")
            print("  1. write the hypothesis, setup and success criterion in its README.md")
            print(f"  2. edit {rel}/config.toml, then: uv run train --exp {exp_id}")
            print(f"  3. uv run exp set {exp_id} VALIDATED|INVALIDATED --result '...'")
        elif args.cmd == "list":
            entries = list_experiments()
            if not entries:
                print('no experiments yet: uv run exp new "<title>"')
            for e in entries:
                result = f"  -> {e.result}" if e.result else ""
                print(f"{e.id}  {e.status:<12} {e.title}{result}")
        elif args.cmd == "set":
            e = set_status(args.id, args.status, args.result)
            print(f"{e.id}: {e.status}" + (f" ({e.result})" if e.result else ""))
    except ExperimentError as e:
        print(f"exp: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
