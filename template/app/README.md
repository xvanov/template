# {{NAME}}

_What this app is, in a sentence._

**Needs:** Node ≥ 22 and Docker.

```bash
./scripts/setup.sh     # .env, dependencies, Postgres + Redis + mail inbox, migrations
make dev               # web on http://localhost:3200 + the background worker
make mobile            # Expo dev server; scan the QR with Expo Go <!-- @module:mobile -->
make desktop           # desktop shell around the web app (needs Rust) <!-- @module:desktop -->
make demo              # a seeded demo workspace; prints a login <!-- @module:hackathon -->
```

Sign up with any email; the confirmation link lands in the local inbox at
http://localhost:8035. `make` lists every command.

## Before you push

```bash
make typecheck && make lint && make test && make smoke
```

## Docs

- [docs/guide.md](docs/guide.md): how it is built, the rules, the traps
- [docs/deploy.md](docs/deploy.md): production on one Docker host <!-- @module:ops -->
- [docs/hackathon.md](docs/hackathon.md): demo day <!-- @module:hackathon -->
- [ml/README.md](ml/README.md): the Python sidecar <!-- @module:ml -->
