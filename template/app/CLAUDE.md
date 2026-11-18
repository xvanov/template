# CLAUDE.md — {{NAME}}

## Project — fill this in

- **What it is:** _one or two sentences._
- **Who uses it:** _the users, and what they need from it._
- **Core journey:** _the one flow that must always work (make `make smoke` drive it)._
- **Not doing:** _what is out of scope for now._

## Working here

Read `docs/guide.md` before changing code: layout, architecture rules, and
the traps already hit. Generated from the app template (profile
`{{PROFILE}}`; modules in `.template.json`).

Gates — nothing is done until all are green:

```bash
make typecheck && make lint
make test        # unit + integration; needs Postgres: make up
make smoke       # production build, booted, driven in a real browser
```
