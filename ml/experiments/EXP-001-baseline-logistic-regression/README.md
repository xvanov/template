# EXP-001: Baseline logistic regression

**Status:** VALIDATED
**Created:** 2026-11-18
**Registry:** [../REGISTRY.md](../REGISTRY.md)

An example of a filled-in experiment. Delete it (folder and registry row)
when you replace the toy problem with yours.

## Hypothesis

A linear model on hashed words + bigrams beats the majority-class baseline
(val accuracy 0.574) by 15+ points.

## Motivation

Every later experiment needs a number to beat. The cheapest model that can
learn the cue words is the baseline; anything fancier has to earn its cost
against it.

## Setup

- **Changes:** none, this is the reference point.
- **Held fixed:** `splits/toy.json` (471 train / 129 val), seed 42, `config.toml` in this folder.
- **Metric:** val accuracy (primary), F1 at threshold 0.5.
- **Baseline:** always predicting "not urgent": 74 of 129 val rows = 0.574.
- **Success criterion:** val accuracy >= 0.724.
- **Command:** `uv run train --exp EXP-001 --run-id exp-001-baseline`

## Results

| Run | Val accuracy | Val F1 (t=0.5) | Baseline accuracy | Delta |
|---|---|---|---|---|
| exp-001-baseline | 0.806 | 0.775 | 0.574 | +23.2 pts |

Full numbers in `metrics.json`. CPU, about 0.1 s.

## Conclusion

VALIDATED: +23.2 points over the majority class.

## Lessons / next step

The toy data tops out near 0.83 accuracy: about 30% of rows carry a cue word
for the other class and 5% of labels are flipped. A learning-rate and epoch
sweep moved val accuracy by under 3 points. Hash width mattered more: at 512
buckets, unrelated words in long notes collided with the cue words and
"Roof leak ... fix today" scored 0.42; at 4096 it scores 0.99.
