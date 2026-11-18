# CLAUDE.md

This repo is a **template**, not an app. Nobody ships it as is.

- **Starting an app?** Do not build in this repo. Generate one:
  `./scripts/new-app.sh ../my-app --profile web` (`--list` shows profiles and
  modules). The new app gets its own short CLAUDE.md to fill in.
- **Working on the template itself?** Read `docs/guide.md` first (the full
  brief: layout, rules, traps), then `template/README.md` (how modules,
  `@module:` markers and profiles work). Anything a module owns must be
  removable: mark it or list it in `template/modules.json`.

Gates — all must be green before anything is done:

```bash
make typecheck && make lint && make test   # make test needs Postgres: make up
make smoke                                 # production build, booted, driven in a browser
scripts/test-profiles.sh web               # a generated app still passes its gates (any profile; none = all)
```
