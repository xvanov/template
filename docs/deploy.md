# Deploying to one Linux host

The production kit: one machine running Docker (a home server is fine),
reachable from the internet through a Cloudflare Tunnel or Tailscale. No
inbound ports, no cloud account required.

| Piece                            | What it does                                                        |
| -------------------------------- | ------------------------------------------------------------------- |
| `docker-compose.prod.yml`        | db, redis, one-shot `migrate`, web, worker, optional `cloudflared`  |
| `scripts/deploy.sh`              | `deploy` · `rollback` · `status`                                    |
| `scripts/backup.sh`              | pg_dump (+ uploads), retention, disk guard, optional off-host rsync |
| `scripts/restore.sh`             | restore a dump, with a safety backup first                          |
| `scripts/lib/migration-guard.sh` | refuses migrations that would break rollback                        |
| `ops/systemd/`                   | backup timer, deploy unit, failure hook, optional auto-deploy timer |
| `.env.deploy.example`            | the ops settings file (see below)                                   |
| `make test-ops`                  | migration-guard unit test + backup/restore round trip (CI `ops`)    |

## How a deploy works

```
git fetch + fast-forward (refuses a dirty or untracked checkout)
  ──► migration guard (new migrations vs the live commit)
  ──► build images tagged <commit>   (the live version keeps serving)
  ──► pre-deploy pg_dump ──► migrate
  ──► PREFLIGHT: new web boots beside the live one, no traffic
  ──► swap web + worker ──► /api/health healthy + worker logged "[worker] up"?
        yes ──► done; old tags kept for `rollback`; build cache trimmed
        no  ──► previous tags put back, waited on until healthy; commit marked FAILED
```

Measured on the reference host (cached build, small database):

- A routine deploy takes about **14s**. The swap itself refused connections
  for **0.3s** (4 of 143 requests probed every 100ms).
- **A web build that cannot get healthy never serves traffic.** Preflight
  catches it, and nothing is replaced: 457 of 457 probes answered 200
  throughout.
- **A worker that crashes on boot** is caught after the swap. It was rolled
  back automatically in 3s, with about 3s of intermittent errors across the
  two swaps.
- `rollback`: **2s**, with 0.3s of refused connections.

That is why it is **not blue/green**. Blue/green would remove the last 0.3s,
but costs a proxy, two copies of the app and several hundred lines of script.
Revisit if a third of a second per deploy ever matters.

## Two env files

| File              | Holds                                                                                | Read by                                              |
| ----------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `.env.production` | the app's settings (auth secret, SMTP, APP_URL, …)                                   | web, worker, migrate, via `env_file` only            |
| `.env.deploy`     | `POSTGRES_PASSWORD`, `PROD_WEB_PORT`, `DEPLOY_*`, `BACKUP_*`, tunnel token, profiles | the scripts and compose interpolation; never the app |

The split keeps ops secrets out of the app. A compromised web process holds
neither the tunnel token nor the backup target. Both files hold secrets:
`chmod 600 .env.production .env.deploy`. Dumps are written owner-only
(`umask 077`), because they contain password hashes, sessions and sealed
secrets.

## First deploy

On the host (Docker installed, your user in the `docker` group):

```bash
git clone <repo> ~/my-app && cd ~/my-app
cp .env.example .env.production
cp .env.deploy.example .env.deploy
chmod 600 .env.production .env.deploy
```

In `.env.deploy`, set:

- `POSTGRES_PASSWORD`: `openssl rand -hex 24`. Use hex: it goes into a URL.
- `DEPLOY_PROJECT=my-app-prod`: pin it. The default `<directory>-prod`
  means renaming the directory would silently point at new, empty volumes.
- `PROD_WEB_PORT`: the loopback port the tunnel points at.

In `.env.production`, set:

- `BETTER_AUTH_SECRET`: `openssl rand -base64 32`.
- `APP_URL` and `BETTER_AUTH_URL`: the public `https://` origin users reach.
  Verification links are built from it.
- `TRUSTED_ORIGINS`: every _other_ origin users reach it on. Otherwise
  sign-in fails with "Invalid origin".
- `SMTP_*`: a real relay. Delete `OUTBOUND_SAFE_MODE=local`, which production
  refuses. Set it to `false` for real mail to real people, or leave it unset.
- `DEV_MAIL_INBOX_URL=` and `EXPO_PUBLIC_DEV_MAIL_INBOX_URL=`: empty.
- `CRON_SECRET`, `EMAIL_WEBHOOK_SECRET`, `SECRETS_ENCRYPTION_KEY`: if you use
  them. In production they fail closed when unset.

You do not need to change `DATABASE_URL`, `REDIS_URL` or `STORAGE_LOCAL_DIR`;
the compose file overrides them. Then deploy:

```bash
scripts/deploy.sh            # or: make deploy
scripts/deploy.sh status
```

The database and Redis publish **no** port. For a psql shell:
`docker compose -p my-app-prod -f docker-compose.prod.yml --env-file .env.deploy exec db psql -U postgres app`.

Install the systemd units. They are `--user` units, so turn on lingering once
(`sudo loginctl enable-linger $USER`) to have them run while you are logged
out. User units cannot order themselves after the system's
`docker.service`, so they don't try: the daemon is up long before they run.
To run them as system units instead, add `User=`, `After=docker.service` and
`WantedBy=multi-user.target` yourself.

```bash
app=$(basename "$PWD"); mkdir -p ~/.config/systemd/user
for f in ops/systemd/app-*; do
  sed -e "s#@APP_DIR@#$PWD#g" -e "s#@APP_NAME@#$app#g" "$f" \
    > ~/.config/systemd/user/"$app-${f##*/app-}"
done
systemctl --user daemon-reload
systemctl --user enable --now "$app-backup.timer"
# OFF by default. Enable only if every push to main should go live within 5 minutes:
# systemctl --user enable --now "$app-deploy.timer"
```

If a backup or a unit-started deploy fails, `<app>-failure@.service` writes an
error-priority line to the journal (`journalctl --user -p err`). Add an
`ExecStart=` to it (an ntfy or webhook `curl`) to be paged.

## Routine deploy

Merge to `main`, then run `scripts/deploy.sh` on the host (or let the timer do
it).

- **It only fast-forwards.** It stops and explains on a dirty checkout, the
  wrong branch, or a local commit that origin lacks. It never merges or forces.
- **Untracked files** that are not git-ignored are refused too. The image is
  built from the working directory, so they would ship in an image the commit
  cannot reproduce.
- **Nothing new** is a no-op. Use `--force` to redeploy the same commit, for
  example after editing `.env.production`: containers read `env_file` when
  they are created, not when they restart.
- **A commit that failed** is refused until a new commit arrives, or you pass
  `--force`. That way the timer cannot rebuild a broken commit every 5
  minutes.
- **Two deploys at once:** the second waits for the first (`flock`), then
  usually finds nothing to do.
- **Triggered from inside a systemd service** (a webhook listener, an agent,
  a terminal server): use `systemctl --user start <app>-deploy` or
  `scripts/deploy.sh --detach`. Both run the deploy in its own unit.
  `setsid`/`nohup` do **not** escape the caller's cgroup, so stopping that
  service kills the deploy halfway.
- **Build cache** is trimmed to `DEPLOY_BUILD_CACHE_MAX` (default 30GB) after
  every successful deploy. Too low, and every build starts cold.

Output from `--detach` goes to `.deploy/deploy.log`. Deploy state lives in
`.deploy/state`: the CURRENT, PREVIOUS and FAILED tags.

## Migrations: expand, then contract

**Rollback swaps code, not schema.** Migrations only run forward. After a
deploy, the _previous_ code must still work on the _new_ schema: both for
`rollback`, and for the automatic rollback when the new version fails its
health check. So every schema change is split across two deploys:

1. **Expand.** Add the new shape (a nullable column, a new table), and ship
   code that writes both shapes and reads the new one. Backfill.
2. **Contract**, in a _later_ deploy, once you will not roll back past step 1.
   Drop the old column, add NOT NULL, rename.

`deploy.sh` enforces this. Before building, it checks the migrations added
between the live commit and the new one, **deny by default**. It refuses:

- every `DROP`, except `DROP INDEX`, `DROP DEFAULT`, `DROP NOT NULL` and
  `DROP CONSTRAINT`;
- every `RENAME`, except `ALTER INDEX … RENAME`;
- any type change in `ALTER TABLE`;
- `SET NOT NULL`;
- `ADD COLUMN … NOT NULL` without a `DEFAULT`. That is what Prisma writes for
  a new required field, and the old code's inserts would fail.
- `TRUNCATE`.

Comments are ignored. One blind spot: `--` inside a string literal hides the
rest of that line. The refused commit is marked FAILED, so the auto-deploy
timer stops retrying it.

The contract step is the deploy you run with `--allow-destructive`, knowing
that rolling back past it needs a restore. For a new required field, expand
means adding it with a `DEFAULT` (or nullable) first.

**When a migration fails,** nothing is replaced and the live version keeps
serving. Each migration runs in a transaction, so the database is unchanged.
But Prisma records the failure (error `P3018`), and refuses every later
migration until you tell it the failed one was rolled back. Fix the SQL in a
new commit, then run:

```bash
APP_TAG=$(git rev-parse --short=12 HEAD) COMPOSE_PROJECT_NAME=my-app-prod \
  docker compose -p my-app-prod -f docker-compose.prod.yml --env-file .env.deploy \
  run --rm --no-deps migrate npx --no-install prisma migrate resolve --rolled-back <migration_dir_name>
scripts/deploy.sh
```

## Rollback

```bash
scripts/deploy.sh rollback     # swap back to the PREVIOUS tags; run again to undo
```

Code only. If a migration itself was the mistake, restore the `pre-deploy`
dump that the deploy took just before migrating.

## Backups

The `<app>-backup.timer` runs `scripts/backup.sh` nightly at about 03:17.
Run it by hand any time.

- Output goes to `backups/<kind>/db-<stamp>.dump` (pg_dump custom format,
  compressed), plus `storage-<stamp>.tar.gz` if local uploads exist.
- Retention: **7 daily, 4 weekly** (the Sunday run), **5 pre-deploy, 5
  pre-restore**. Every keep count must be at least 2. Old copies are pruned
  _before_ writing.
- **Disk guard:** it refuses to run if free disk would drop under
  `BACKUP_MIN_FREE_MB` (default 2048). The expected size is the last dump plus
  25%, plus the uploads volume.
- **Checks:** each dump must pass `pg_restore --list`, and each tarball
  `gzip -t`, before it is kept.
- **Off-host copy:** set `BACKUP_RSYNC_TARGET=user@nas:/backups/my-app` in
  `.env.deploy` (ssh key auth). A failed push fails the unit, and the local
  copy is kept. Without an off-host copy, a dead disk takes the backups with
  it.

## Restore

```bash
scripts/restore.sh latest                                   # newest dump of any kind
scripts/restore.sh backups/daily/db-20261116-031700.dump    # a specific one
scripts/restore.sh <dump> --with-storage                    # uploads too
scripts/restore.sh <dump> --flush-redis                     # empty the job queue too
```

It asks you to type `restore` (`--yes` skips the prompt), then:

1. holds the dump open, so nothing can delete it mid-restore;
2. dumps the current database to `backups/pre-restore/`, never pruning the
   file being restored;
3. stops web and worker, then drops and recreates the database;
4. restores in **one transaction**;
5. runs the live image's migrations;
6. starts web and worker again.

If anything fails after web and worker stopped, it says so and prints the
exact `scripts/restore.sh <pre-restore dump> --yes` command that puts the
previous data back.

- **Redis is not restored.** Jobs queued before the restore may name rows
  that no longer exist. They fail and are recorded in `job_run`.
  `--flush-redis` drops every queued, delayed and scheduled job instead; the
  worker re-registers its cron schedules on start.
- **`--skip-safety-backup`** is for when the current database cannot be
  dumped (the disk is full, or the data is corrupt). It always asks you to
  type `restore without backup`, even with `--yes`, because there is then no
  way back.

`make test-ops` exercises all of this against a throwaway Postgres in about
20s: the round trip, restoring the oldest pre-restore dump, a failure that
must print a working undo, retention, and file modes.

## Public exposure

The web container is bound to `127.0.0.1:${PROD_WEB_PORT}` only. Docker's
published ports bypass ufw, so that binding is the real control. Pick one
front door:

**Cloudflare Tunnel** (a public domain, TLS at Cloudflare, no open port):

1. In the Cloudflare dashboard, go to Zero Trust → Networks → Tunnels and
   create a tunnel (type _cloudflared_). Copy its token.
2. Under Public hostname, add `app.example.com` with service
   **`http://web:3000`**. cloudflared runs inside the compose network, so it
   uses the service name, not localhost.
3. In `.env.deploy`, set `COMPOSE_PROFILES=tunnel` and
   `CLOUDFLARE_TUNNEL_TOKEN=<token>`. In `.env.production`, set `APP_URL` and
   `BETTER_AUTH_URL` to `https://app.example.com`.
4. Run `scripts/deploy.sh --force`. The `cloudflared` service starts with the
   stack. Its image is pinned: bump it every few months.

If cloudflared already runs on the host as a systemd service with a
`config.yml`, point its ingress at `http://localhost:<PROD_WEB_PORT>` instead,
and leave the profile off.

**Tailscale** (tailnet only):
`tailscale serve --bg --https=8443 http://127.0.0.1:<PROD_WEB_PORT>`. See the
README's Tailscale section for port collisions.

Either way, the public origin must be in `APP_URL`, or in `TRUSTED_ORIGINS`
if it is a second origin. Redeploy with `--force` afterwards so the containers
pick it up.
