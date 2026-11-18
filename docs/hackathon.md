# Hackathon playbook

From a clone to a demo in ten minutes, then the checklist for judging day,
then competition (Kaggle) notes. Commands are run from the repo root unless
they start with `cd`.

## The 10-minute path

**0. Prerequisites (once per machine):** Node 22+, Docker. For ML work also
[uv](https://docs.astral.sh/uv/) (`curl -LsSf https://astral.sh/uv/install.sh | sh`).

```bash
git clone <repo> app && cd app
make doctor          # read-only checklist: tools, .env, ports, services, uv, GPU
make demo            # setup if needed, infra, migrations, demo data, web + worker
```

`make demo` prints the URL and a login (`demo@example.com` / `demo-password`)
that works at once: no sign-up, no email round trip. The workspace has items,
a handbook indexed for search ("warranty", "reschedule"), and a customer email
in the inbox. It all works with the AI off. Ctrl-C stops it; running it again
RESETS the demo workspace (its items, documents and inbox go back to the
seeded content). The seed only touches a workspace and an account it created
itself, and only in a database on this machine: it refuses an existing real
account with the demo email.

**Then make it yours** (CLAUDE.md, "Starting a real app from this template"):

1. Rename `Item` to your thing (keep `organizationId` and the index shape).
2. Change `apps/worker/src/demo/data.ts` so the demo tells YOUR story.
3. AI: put a key in `.env` (`ANTHROPIC_API_KEY=...`) or point `local/` at a
   server (`ml/README.md`, "Serving a model"). Leave `LLM_DAILY_CAP_USD` on.
4. ML: `cd ml && uv run train` and read `ml/README.md`. Replace `toy.py`.

Port clash with another project? Change `WEB_PORT` and `APP_URL` (same port),
plus `DB_PORT`/`DATABASE_URL` etc. in `.env`; `make doctor` flags a mismatch.

## While building

- `make doctor` whenever something is "just broken": it catches the usual
  suspects (Docker down, wrong port in `APP_URL`, an unquoted `<` in `.env`,
  Postgres not up, a GPU driver that needs a reboot).
- Merge to main only through the gates (`make typecheck lint test smoke`).
  A demo that broke at 3 a.m. costs more than the gate's minutes.
- ML ideas go through `uv run exp new` (ml/README.md, "Experiments"). With
  several people or agents, the registry is how nobody re-runs a dead idea.
- Long GPU runs write `ml/runs/<id>/status.json`; `uv run status` (or
  `ssh gpu-box cat .../status.json` from your phone) says whether it is alive.
- Event rules sometimes say "only dependencies published before X". uv can
  enforce it: `uv lock --exclude-newer 2026-10-03`; for npm, check
  `npm view <pkg> time` before adding one.

## Judging day

**The day before**

- [ ] Rehearse the demo end to end, out loud, with a timer. Then cut it by a third.
- [ ] Record a screen capture of the full demo as the fallback for a dead network.
- [ ] Deploy, or run the demo from a laptop; know which. For
      a public URL, do NOT seed the demo account: create a real one. Keep
      `OUTBOUND_SAFE_MODE` strict (the default in production) so the demo cannot
      email or text a real person.
- [ ] AI: a cap set (`LLM_DAILY_CAP_USD`), a priced model, and an answer for
      "what if the API is down?" (the app runs with the AI off; say so).
- [ ] GPU box: `ml/serve/health.sh --wait 60` passes; the container restarts
      itself (`--restart unless-stopped`); you know the tunnel command.

**Two hours before**

- [ ] `bash scripts/freeze.sh --url <demo url>` (`make freeze` = the same with
      `APP_URL` from `.env` as the URL):
      refuses a dirty tree, runs every gate uncached, writes SUBMISSION.md
      (commit, URL, how to run, gate timings, sha256 of model files that are
      not in git), commits it and tags `submission-<date>`. Then push what it
      prints: `git push origin HEAD && git push origin <tag>`.
- [ ] Submit the form with the TAG's link, not a branch's: a branch moves.
- [ ] Fresh-clone check on another machine or directory:
      `git clone ... && make doctor && make demo`.

**At the table**

- [ ] Laptop charged, notifications off, browser zoom up, logged in, tabs open.
- [ ] Phone hotspot as backup network; the screen capture on the desktop.
- [ ] `make demo` again to reset the demo workspace if the last run left a mess.

## Kaggle and other competitions

```bash
# Credentials: Kaggle → Settings → Create New Token → ~/.kaggle/kaggle.json
chmod 600 ~/.kaggle/kaggle.json          # or KAGGLE_USERNAME / KAGGLE_KEY in your shell, never in .env
cd ml
uvx kaggle competitions list -s <words>  # uvx: the CLI without adding it to the project
uvx kaggle competitions download -c <slug> -p data/raw && (cd data/raw && unzip -q '*.zip')
```

- **Accept the rules on the competition page first**: until you do, the
  download is a 403 that looks like a credentials problem.
- **Never commit data.** `ml/data/*` and `kaggle.json` are gitignored. Data
  goes in `ml/data/raw/` untouched, derived files in `ml/data/processed/`
  (rebuildable by a script). Keep a copy of the rules, the metric definition
  and the data description in the experiment that first used them.
- **Fix the validation split first** (`ml/splits/`, committed) and compare
  every experiment on it. Record CV and public leaderboard side by side in
  each experiment; when the gap between them grows, trust the gap, not the
  leaderboard (the public board is a small sample, and climbing it by
  resubmitting is fitting noise).
- **Mirror the competition's hardware and time limits** in `config.toml`
  (`device.require_gpu`, batch size) and in a benchmark experiment early:
  finding out at the end that inference takes 6 s against a 5 s limit is
  common and expensive.
- Submit with a message that names the experiment and run:
  `uvx kaggle competitions submit -c <slug> -f submission.csv -m "EXP-007 run exp-007-..."`.
  Daily submission limits are small: spend them on validated experiments.
