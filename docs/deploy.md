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
| `ops/systemd/`                   | nightly backup timer; deploy unit; optional auto-deploy timer       |
| `scripts/test-backup-restore.sh` | the round-trip test (`make test-ops`, CI `ops` job)                 |

## How a deploy works

```
git fetch + fast-forward ──► build images tagged <commit>  (live version keeps serving)
  ──► pre-deploy pg_dump ──► migrate ──► PREFLIGHT: new web boots beside the live one, no traffic
  ──► swap web + worker ──► /api/health healthy + worker logged "[worker] up"?
        yes ──► done; old tags kept for `rollback`
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

## First deploy

On the host (Docker installed, your user in the `docker` group):

```bash
git clone <repo> ~/my-app && cd ~/my-app
cp .env.example .env.production
```

Edit `.env.production`. Everything not listed here can keep its default.

- `POSTGRES_PASSWORD`: `openssl rand -hex 24`. Use hex: it goes into a URL.
- `BETTER_AUTH_SECRET`: `openssl rand -base64 32`.
- `APP_URL` and `BETTER_AUTH_URL`: the public `https://` origin users reach.
  Verification links are built from it.
- `TRUSTED_ORIGINS`: every _other_ origin users reach it on (a Tailscale
  name, for example). Otherwise sign-in fails with "Invalid origin".
- `PROD_WEB_PORT`: the loopback port the tunnel points at (default 3280).
  This is **not** `WEB_PORT`, which is the dev server's port.
- `DEPLOY_PROJECT=my-app-prod`: pin it. The default is `<directory>-prod`,
  so renaming the directory would silently point at new, empty volumes.
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
`docker compose -p my-app-prod -f docker-compose.prod.yml --env-file .env.production exec db psql -U postgres app`.

Install the systemd units. They are `--user` units, so turn on lingering once
(`sudo loginctl enable-linger $USER`) to have them run while you are logged
out:

```bash
app=$(basename "$PWD"); mkdir -p ~/.config/systemd/user
for f in ops/systemd/app-*; do
  sed -e "s#@APP_DIR@#$PWD#g" -e "s#@APP_NAME@#$app#g" "$f" \
    > ~/.config/systemd/user/"$app-${f##*/app-}"
done
systemctl --user daemon-reload
systemctl --user enable --now "$app-backup.timer"
# optional — every push to main goes live within 5 minutes:
# systemctl --user enable --now "$app-deploy.timer"
```

## Routine deploy

Merge to `main`, then run `scripts/deploy.sh` on the host (or let the timer do
it). It only fast-forwards. A dirty checkout, the wrong branch, or a local
commit that origin lacks makes it stop and tell you. It never merges or forces.

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

Output from `--detach` goes to `.deploy/deploy.log`. Deploy state lives in
`.deploy/state`: the CURRENT, PREVIOUS and FAILED tags.

## Rollback

```bash
scripts/deploy.sh rollback     # swap back to the PREVIOUS tags; run again to undo
```

**Rollback swaps code, not schema.** Migrations only run forward, so the
previous code must run on the new schema. Write migrations so the old code
still works: add a column, backfill it, and drop the old one in a _later_
deploy. If a migration itself was the mistake, restore the `pre-deploy`
dump that every deploy takes just before migrating (see below).

## Backups

The `<app>-backup.timer` runs `scripts/backup.sh` nightly at about 03:17.
Run it by hand any time.

- Output goes to `backups/<kind>/db-<stamp>.dump` (pg_dump custom format,
  compressed), plus `storage-<stamp>.tar.gz` if local uploads exist.
- Retention: **7 daily, 4 weekly** (the Sunday run), **5 pre-deploy, 5
  pre-restore**. Old copies are pruned _before_ writing.
- It refuses to run if free disk would drop under `BACKUP_MIN_FREE_MB`
  (default 2048) plus the expected dump size. It checks every dump with
  `pg_restore --list` before keeping it.
- **Off-host copy:** set `BACKUP_RSYNC_TARGET=user@nas:/backups/my-app` (ssh
  key auth). A failed push fails the unit, and the local copy is kept.
  Without an off-host copy, a dead disk takes the backups with it.
- Settings, all in `.env.production`: `BACKUP_DIR`, `BACKUP_KEEP_DAILY`,
  `BACKUP_KEEP_WEEKLY`, `BACKUP_KEEP_PRE`, `BACKUP_MIN_FREE_MB`,
  `BACKUP_RSYNC_TARGET`.
- Check the timer with
  `systemctl --user list-timers` and `journalctl --user -u <app>-backup`.

## Restore

```bash
scripts/restore.sh latest                                   # newest dump of any kind
scripts/restore.sh backups/daily/db-20261116-031700.dump    # a specific one
scripts/restore.sh <dump> --with-storage                    # uploads too
```

It asks you to type `restore` (`--yes` skips the prompt), then:

1. dumps the current database to `backups/pre-restore/`, so a restore can be
   undone;
2. stops web and worker, then drops and recreates the database;
3. restores in **one transaction**;
4. runs the live image's migrations, so an older dump is brought up to the
   schema the running code expects;
5. starts web and worker again.

It took 4s on the reference host. `make test-ops` proves the round trip
against a throwaway Postgres in about 10s.

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
3. Add to `.env.production`:
   ```
   COMPOSE_PROFILES=tunnel
   CLOUDFLARE_TUNNEL_TOKEN=<token>
   APP_URL=https://app.example.com
   BETTER_AUTH_URL=https://app.example.com
   ```
4. Run `scripts/deploy.sh --force`. The `cloudflared` service starts with the
   stack.

If cloudflared already runs on the host as a systemd service with a
`config.yml`, point its ingress at `http://localhost:<PROD_WEB_PORT>` instead,
and leave the profile off.

**Tailscale** (tailnet only):
`tailscale serve --bg --https=8443 http://127.0.0.1:<PROD_WEB_PORT>`. See the
README's Tailscale section for port collisions.

Either way, the public origin must be in `APP_URL`, or in `TRUSTED_ORIGINS`
if it is a second origin. Redeploy with `--force` afterwards so the containers
pick it up.
