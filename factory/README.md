# Handing this app to the software factory

The factory (`../software-factory`) turns markdown work orders into reviewed,
tested, merged pull requests. This directory holds the glue.

## One-time wiring

```bash
APP=my-app                      # the name you will use with --factory --app
FACTORY=~/software-factory

mkdir -p "$FACTORY/apps/$APP/directions"
cp factory/config.yaml "$FACTORY/apps/$APP/config.yaml"
# then edit: name, repo, app_repo_path, context_dir
```

Check it registered:

```bash
cd "$FACTORY" && uv run factory apps
```

## Giving it work

A **direction** is the unit of work — a markdown PRD the PM persona triages and
splits into stories. Write one with the factory's own interview flow:

```bash
cd "$FACTORY" && uv run factory new-direction --app "$APP"
```

Then:

```bash
uv run factory pm-sync --app "$APP"   # triage directions → stories
uv run factory tick --app "$APP"      # drive every in-flight story one step
uv run factory status --app "$APP"    # where everything is right now
```

## Why the gates are shared

`config.yaml` points the factory's merge gates at the same `npm run …` and
`scripts/smoke.sh` commands a human uses. That is deliberate: if the factory
gated on a different, weaker set of commands, "the factory says it is green"
would stop meaning "it works". The smoke gate in particular is what stops a
green-but-unbootable app from merging.

## Before the first factory run

- Push the repo to GitHub and enable branch protection + auto-merge (the factory
  merges through real CI, not around it).
- Confirm `make smoke` passes locally. The factory cannot ship through a gate
  that is already red.
- Confirm `.github/workflows/ci.yml` runs green on a pull request.
