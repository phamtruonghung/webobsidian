# Changelog

All notable changes to WebObsidian are documented here. This project tracks its product
design and version history in [PRD.md](PRD.md); the entries below summarize user-facing
changes. The format is loosely based on [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Build identity in `/healthz` — "which version is running?"

- `GET /healthz` now returns `{"ok":true,"version":"<repo version>","build":"<git commit>"}`; the
  commit is baked into the image by the deploy pipeline (`--build-arg GIT_SHA=…`, surfaced as
  `WEBOBSIDIAN_BUILD_SHA`), so the running version is one curl away — locally, from the host, or over
  the public URL. `build: dev` means the image was built outside `deploy/deploy.sh`.
- `deploy/deploy.sh` passes that build arg, and its smoke test now **asserts the running `build`
  equals the deployed commit**.
- **Fixed:** a deploy could rebuild the image while the old container kept running — `docker compose up
  -d` does not always recreate when only the image content changed, and the smoke test cannot tell
  because the previous container answers the same endpoints. `ensure_running_image` compares the
  container's image id with the freshly built one, forces a recreate on mismatch, and fails the deploy
  if the container still is not running the new build.

### Deploy pipeline (LXC 107) — deploy-on-merge CI/CD

- `deploy/deploy.sh`: idempotent deploy (sync → rolling backup → keep the previous image as
  `webobsidian:rollback` → build → `up -d` → wait for healthy → smoke) with automatic rollback when
  the build or the smoke test fails; `--bootstrap`, `--rollback`, `--backup-only` modes.
- `deploy/smoke.sh`: asserts a *running* deployment (`/healthz`, the SPA bundle, `/auth/status`
  exposing only `passwordSet`, `123456` refused once a credential is configured, the operator password
  logging in) — never prints a secret.
- `.github/workflows/deploy.yml`: deploys after **CI succeeds for a push to `main`** (plus manual
  dispatch) on a self-hosted runner inside the target LXC, which is behind NAT. `workflow_run.event ==
  'push'` is checked so a fork PR can never reach the deploy runner; `concurrency` prevents overlapping
  deploys.
- `docs/DEPLOYMENT.md`: host layout, deploy path, runbook, backup/rollback, one-time runner setup.

### Fixed

- Healthcheck probed `localhost`, which resolves to `::1` inside the image while the server binds IPv4
  only — the container reported `unhealthy` forever while serving normally. Now `127.0.0.1` in both
  `docker-compose.yml` and `Dockerfile`.

### Fork integration — every open upstream PR merged

This tree is the `phamtruonghung/webobsidian` fork with all 17 open pull requests from
`xnohat/webobsidian` merged on top of `v0.1.1` (see
[docs/UPSTREAM_PR_MERGES.md](docs/UPSTREAM_PR_MERGES.md) for the table, the conflict decisions and
the bug fixes made while merging):

- **Security**: the well-known default password `123456` is refused as soon as any credential
  (`userPasswordHash`, `auth.passwordHash`, `WEBOBSIDIAN_PASSWORD`) is configured, and
  `GET /auth/status` no longer leaks `mustChangePassword` to unauthenticated callers (PRs #4 + #15);
  `PUT /api/settings` authorizes `vault.path` against operator-configured roots, not the request body
  (PR #2, with the test suite from #6/#7); shared canvases drop unsafe URL schemes (PR #3).
- **Vault**: symlinks inside the vault are listed/read/written when their target is an allowed root,
  with a realpath cycle guard (PR #23).
- **Editor & UI**: reusable preview tabs (PR #29); graph mobile touch, node dragging and ghost-node
  fix (PR #25); Catppuccin themes (PR #11); dark-mode text contrast (PR #10); Account settings tab
  and code comments in English (PRs #8/#9); percent-encoded image targets and table-cell italics
  (PRs #13/#14).
- **Tooling**: `webo` CLI process manager + graceful SIGTERM/SIGINT shutdown (PR #27); server test
  suite (vitest) and web store tests (`node --test`); dependency refresh to 0 production advisories
  (PR #24).

### Added
- **`webo` Process Manager CLI** (`packages/webo`): command-line utility to manage WebObsidian as a background daemon process (`webo install`, `webo start`, `webo stop`, `webo status`, `webo logs`, `webo restart`, `webo config`, `webo uninstall`). Configured centrally via `~/.webobsidian/.env`. *(PRD 1.6 - FR-14)*
- Server graceful shutdown handlers for SIGTERM/SIGINT signals (cleans up HTTP server, WebSockets, file watcher, and autosync timers).
- Open-source repository scaffolding: `README.md` (with logo), `LICENSE` (MIT),
  `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, GitHub issue/PR templates and a
  CI workflow (typecheck, build, Docker image).
- File tree **Copy / Cut / Paste** for files and folders (session-local clipboard;
  `POST /api/files/copy` for recursive copy). *(PRD 0.9)*

### Changed
- ⋯ **More options** menu rebuilt for parity with Obsidian Desktop: backlinks-in-document,
  open linked view, open in new window, add file property, in-note Find, export to PDF,
  reveal file in navigation, and per-file version history. *(PRD 0.8)*

## Highlights by PRD revision

- **0.9** — File tree Copy/Cut/Paste; recursive copy endpoint.
- **0.8** — ⋯ menu parity with Obsidian Desktop; per-file Git version history (FR-4).
- **0.7** — Per-note **Share dialog** (create/copy/toggle/password/delete) + globe badge.
- **0.6** — Deploy hardening for self-hosting: all deploy params via `.env`, watcher polling
  fallback on inotify limits, longer healthcheck `start_period` (FR-9).
- **0.5** — Graph node search with smooth fly-to and highlighting (FR-2).
- **0.4** — Mobile / responsive UI: drawer sidebars, edge-swipe, on-keyboard formatting
  toolbar, touch targets, safe-area insets (FR-11).
- **0.3** — Per-pane ⋯ menu (split, bookmark, rename/move, etc.) and a redesigned right
  sidebar tab strip (Backlinks incl. unlinked mentions · Outgoing links · Tags · Outline).
- **0.2** — Deep-link URLs (`/note/...`), public read-only share links with central
  management, server-side rendering for SEO (FR-10).

## Core (v1 baseline)

- Obsidian-compatible vault (works on existing `.obsidian/` vaults).
- CodeMirror 6 editor with live/source/reading views; wikilinks, embeds, tags, callouts,
  tasks, KaTeX, Mermaid; backlinks, outline, graph view.
- QMD full-text + fielded search (MiniSearch), incremental indexing, disk persistence.
- GitHub sync (pull/commit/push) with Git LFS.
- Single master password login (scrypt + JWT cookie).
- Scoped Agent API at `/api/v1` with hashed API keys and rate limiting.
- Community-plugin loader against an Obsidian-API shim (subset).
- Pure-JSON config (`data/settings.json`); one-command Docker stack.

---

> Note: WebObsidian is pre-1.0 and has not cut tagged releases yet. Once releases begin,
> each version will get its own dated section here.
