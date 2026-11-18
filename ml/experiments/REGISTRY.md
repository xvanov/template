# Hypothesis registry

One row per experiment. **Read this before starting anything**: it is how you
find out an idea was already tried, and why it did not work.

## How to use it

1. `uv run exp new "<title>" --hypothesis "<one falsifiable sentence>"` creates
   `EXP-<n>-<slug>/` from `_template/` and adds a row here (status `PLANNED`).
2. Fill in the experiment's README (setup, the ONE thing that changes, the
   success criterion) **before** running it. Writing the criterion after seeing
   the numbers is how a noise blip becomes a "win".
3. `uv run train --exp EXP-<n>` runs with the experiment's `config.toml` and
   appends each run's metrics to its `metrics.json`.
4. `uv run exp set EXP-<n> VALIDATED|INVALIDATED|INCONCLUSIVE --result "..."`,
   then write the conclusion and the lesson in its README. A negative result is
   a result: keep it, with the reason.
5. Update **Current best** below when a result beats it on the fixed split.

Compare runs only on the same split (`splits/*.json`, checked on every load).
After a `--resplit`, earlier numbers are not comparable; say so in the row.

## Status legend

| Status | Meaning |
|---|---|
| PLANNED | Designed, not run |
| RUNNING | Being run now |
| VALIDATED | The success criterion was met |
| INVALIDATED | It was not: the hypothesis is false (keep the lesson) |
| INCONCLUSIVE | Within noise, or the setup turned out flawed |
| ABANDONED | Stopped before a result (say why) |

## Current best

| Metric (val, fixed split) | Value | Experiment | Run |
|---|---|---|---|
| F1 | 0.775 | EXP-001 | `exp-001-baseline` |

## Experiments

<!-- Rows are edited by `uv run exp`; keep one row per line and no blank lines inside the table. -->
| ID | Title | Status | Hypothesis | Result | Folder |
|---|---|---|---|---|---|
| EXP-001 | Baseline logistic regression | VALIDATED | A linear model on hashed words + bigrams beats the majority-class baseline (val accuracy 0.574) by 15+ points | val accuracy 0.806 vs 0.574, F1 0.775 (run exp-001-baseline) | EXP-001-baseline-logistic-regression/ |

## Lessons

<!-- The short version of what the experiments taught. Newest first. -->

- EXP-001: the toy data tops out near 0.83 accuracy (about 30% of rows carry a cue word for the other class, 5% of labels are flipped). Hash width matters more than learning rate: at 512 buckets, unrelated words collided with the cue words.
