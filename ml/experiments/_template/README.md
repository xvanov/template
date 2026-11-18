# {{id}}: {{title}}

**Status:** PLANNED
**Created:** {{date}}
**Registry:** [../REGISTRY.md](../REGISTRY.md)

## Hypothesis

{{hypothesis}}

## Motivation

Why this, why now. What evidence (an earlier experiment, an error analysis, a
paper) says it could work? Link it.

## Setup

- **Changes (the ONE independent variable):** baseline value -> this experiment's value.
- **Held fixed:** split file, seed, everything else in `config.toml`.
- **Metric:** which one, on which split (e.g. val F1 on `splits/toy.json`).
- **Baseline:** the run or experiment this is compared with, and its score.
- **Success criterion (written BEFORE running):** e.g. "val F1 +0.02 or more
  over the baseline across 3 seeds".
- **Command:** `uv run train --exp {{id}}`

## Results

Fill from `metrics.json` (every run is appended there). State the threshold or
operating point when you report precision/recall.

| Run | Metric | Baseline | Delta |
|---|---|---|---|
| | | | |

## Conclusion

VALIDATED / INVALIDATED / INCONCLUSIVE, in one sentence, and why.

## Lessons / next step

What this changes about what to try next. Copy the one-line version into the
registry's Lessons section.
