# Deployment — this fork on LXC 107

How the fork is deployed, what the CI/CD path does, and the runbook for a human. Written for the
actual production host (LXC 107 on the Proxmox node, `192.168.1.22`), but nothing here is specific to
it except the paths.

## Where it runs

| Piece | Value |
|-------|-------|
| Host | Proxmox LXC **107**, x86_64, Docker 29.x (no Node on the host — docker-only deployment) |
| Deploy checkout | `/root/webobsidian` — a clone of **this fork**, `main` |
| Compose project | `webobsidian` (set explicitly, so the volume name never depends on the directory) |
| Stack | `docker-compose.yml` → container `webobsidian`, image `webobsidian:latest`, `0.0.0.0:8787` |
| Vault | host bind `/root/obsidian-data` → `/vault` — **never touched by a deploy** |
| App data | named volume `webobsidian_webobsidian-data` → `/data` (`settings.json`, `uistate.json`, `qmd-index.json`) |
| Env | `/root/webobsidian/.env` (git-ignored; the only place deploy parameters and the operator password live) |
| Backups | `/root/backups/webobsidian-backup/` — one rolling backup, replaced each deploy |
| Rollback image | `webobsidian:rollback` (the previous good image) |
| Public URL | `https://webobsidian.digitalciapp.com` via the cloudflared tunnel on the Proxmox host |
| CI/CD runner | self-hosted GitHub Actions runner in the LXC, labels `self-hosted`, `webobsidian-107` |

The vault is a bind mount, so an upgrade cannot move, copy or lose notes. Only `/data` is snapshotted,
and `settings.json` in that volume survives deploys because the volume (and its name) is reused.

## Deploy path

`.github/workflows/deploy.yml` runs on a **self-hosted runner inside LXC 107** — the container is
behind NAT, so no GitHub-hosted runner can reach it and no inbound port is opened. It triggers:

1. automatically, after the **CI** workflow completes successfully for a **push to `main`** (i.e. a
   merged PR). `workflow_run.event == 'push'` is checked explicitly, because `workflow_run` also fires
   for `pull_request` runs and a fork PR must never reach the deploy runner;
2. manually via **Actions → Deploy (LXC 107) → Run workflow**.

The job pins the deploy checkout to the exact merged commit, then runs `deploy/deploy.sh`:

```
sync checkout → rolling backup → tag current image as webobsidian:rollback
              → docker compose build → up -d → wait for healthy → deploy/smoke.sh
              → on any failure: retag rollback image, up -d, exit non-zero
```

`concurrency: deploy-lxc107` (no cancel) means deploys queue instead of overlapping.

## Runbook

```bash
ssh root@192.168.1.22 'pct exec 107 -- bash -lc "cd /root/webobsidian && deploy/deploy.sh"'
```

| Want | Command |
|------|---------|
| Deploy current `main` | `deploy/deploy.sh` (syncs to `origin/main`, rebuilds, smoke-tests) |
| Deploy a specific commit | `git -C /root/webobsidian checkout --force <sha> && SYNC=0 deploy/deploy.sh` |
| Adopt/replace the checkout | `GIT_REMOTE_URL=https://github.com/phamtruonghung/webobsidian.git deploy/deploy.sh --bootstrap` |
| Back up only | `deploy/deploy.sh --backup-only` |
| Roll back the image | `deploy/deploy.sh --rollback` |
| Tail the app | `docker compose -f /root/webobsidian/docker-compose.yml -p webobsidian logs -f webobsidian` |
| Health | `docker inspect -f '{{.State.Health.Status}}' webobsidian` |

`deploy/smoke.sh [url]` can be run on its own against any running deployment; it asserts the fork's
behaviour (`/healthz`, the SPA bundle, `/auth/status` exposing **only** `passwordSet`, `123456`
refused once a credential is configured, the operator password logging in) and is what the deploy job
gates on. It never prints a secret.

## Backups and rollback

- **Backup** (`--backup-only`, also run automatically before every deploy): `/data` volume tarball,
  a **manifest** of the vault (path, file count, byte count, sorted file list), a copy of `.env`, and
  the git state (origin, HEAD, `git status`, uncommitted diff) of the directory being replaced.
  Default `BACKUP_KEEP=1` — one rolling backup, replaced each time.
- **Image rollback**: the previous image is retagged as `webobsidian:rollback` before each build, so
  `deploy/deploy.sh --rollback` brings the last good build back in seconds. A failed smoke test
  triggers that automatically.
- **What rollback does *not* cover**: it reverts the **image**, not configuration. If `.env` itself is
  wrong (e.g. `WEBOBSIDIAN_PASSWORD` drift), the rolled-back container still reads the same `.env`, so
  the deploy fails, exits non-zero, and leaves the previous build live but with the drifted config —
  fix `.env` and run the deploy again. Rehearsed locally: a shell `WEBOBSIDIAN_PASSWORD` overriding
  `.env` made smoke fail with `401`, and the script retagged the previous image, recreated the
  container, reported `smoke test failed — rolled back` and exited `1`.
- **Data restore**: the vault is a bind mount and is never modified; to restore `/data`, extract
  `data-<ts>.tar.gz` into `/var/lib/docker/volumes/webobsidian_webobsidian-data/_data` with the stack
  stopped (`tar -x -z -f data-<ts>.tar.gz -C <that dir>`; dash-prefixed flags so a host tar wrapper
  can't mangle them).

## One-time host setup (already done, kept for rebuilds)

1. `docker` + compose plugin installed in the LXC (Ubuntu 24.04).
2. Runner: download `actions/runner` into `/root/actions-runner`, register with a repo registration
   token (`gh api -X POST repos/phamtruonghung/webobsidian/actions/runners/registration-token -f ...`),
   labels `self-hosted,webobsidian-107`, then `./svc.sh install && ./svc.sh start`.
   The runner runs as root, which is what lets the job drive Docker.
3. `/root/webobsidian/.env` — `VAULT_HOST_PATH=/root/obsidian-data`, `HTTP_BIND=0.0.0.0`,
   `HTTP_PORT=8787`, `TRUST_PROXY=true`, `WEBOBSIDIAN_PASSWORD=<operator override>`,
   `WEBOBSIDIAN_WATCH=auto`.

### Migration off the upstream checkout (2026-09-20)

LXC 107 originally ran a clone of `xnohat/webobsidian` with a host-local
`docker-compose.override.yml` patching an upstream healthcheck bug (`localhost` → `::1` inside the
container while the server binds IPv4 only, so the probe failed forever and the container reported
unhealthy while serving fine). Both the checkout and that workaround are gone:

- the IPv4 healthcheck is fixed in the fork's `docker-compose.yml` **and** `Dockerfile`;
- `deploy/deploy.sh --bootstrap` backed up `.env`, the git state and `/data`, replaced the directory
  with a clone of this fork, restored `.env`, dropped the override, and deployed;
- the same vault path and the same named volume were reused, so no data was copied and none was lost.
