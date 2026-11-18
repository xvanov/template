# App template

A running starting point for a new app: Next.js web app and typed API (tRPC),
Postgres, auth with organizations, background jobs, file storage and a real
end-to-end gate, plus optional modules (AI, agents, document search, mobile,
desktop, Python ML, production ops). You do not edit this repo to build an
app: you generate a new one with only the modules you need.

**Needs:** Node ≥ 22, Docker. (Rust only for desktop, uv only for ml.)

## Start an app

```bash
./scripts/new-app.sh ../my-app --profile web --name "My App"
cd ../my-app && ./scripts/setup.sh && make dev    # → http://localhost:3200
```

| Profile     | What you get                                                        |
| ----------- | ------------------------------------------------------------------- |
| `web`       | browser-only app + production deploy kit (default)                  |
| `web-ai`    | web + LLM calls, agent with approvals + MCP, document search, evals |
| `mobile`    | web + Expo mobile app with push notifications                       |
| `desktop`   | web + Tauri desktop shell                                           |
| `glasses`   | mobile + AI + the Meta glasses module                               |
| `hackathon` | web + AI + Python ML + `make doctor/demo/freeze`, no production kit |
| `full`      | everything (this repo)                                              |

Fine-tune with `--with sms,inbound` or `--without ops`; dependencies come
along automatically. `./scripts/new-app.sh --list` shows every profile and
module. The generator copies the template, cuts the unused modules (code,
tables, env vars, CI jobs, docs), renames the app (`--name`, `--scheme`,
`--bundle-id`), installs, and makes the first git commit. Then fill in the
Project section of the new app's `CLAUDE.md`.

## Working on the template

```bash
./scripts/setup.sh && make dev     # run the full template as an app
make typecheck && make lint && make test && make smoke
scripts/test-profiles.sh           # generate every profile and run its gates
```

- [docs/guide.md](docs/guide.md): how everything works, the rules, the traps
- [template/README.md](template/README.md): modules, markers, profiles
- [docs/deploy.md](docs/deploy.md): production on one Docker host
- [docs/hackathon.md](docs/hackathon.md): clone to demo, fast
