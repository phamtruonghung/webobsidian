# Contributing to WebObsidian

Thanks for your interest in improving WebObsidian! This project is self-hosted, single-user,
and design-driven — please read the few rules below before opening a PR.

## Ground rules (from [CLAUDE.md](CLAUDE.md))

1. **[PRD.md](PRD.md) is the source of truth for design.** Before building a feature, check
   the matching FR/NFR/API/data-model section. If your change shifts scope or architecture,
   **update PRD.md first** (state the reason, bump the version/changelog), then write code.
2. **Keep [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) in sync.** Flip checkboxes
   (`[ ]` → `[~]` → `[x]`), update the "last updated" line, and add a progress-log entry.
   Only mark `[x]` when the code actually runs / is verified.
3. **Docs are the source of truth.** When scope changes, update PRD.md *and*
   IMPLEMENTATION_PLAN.md in the same change.

## Technical conventions

- **TypeScript** for both server and web. Avoid `any` where possible.
- **Runtime config is JSON only** (`data/settings.json`) — do not add a DB engine.
- **Security:** never log secrets/tokens/API keys; hash before storing; guard against path
  traversal.
- **Editor CSS:** vertical spacing on an element CodeMirror renders as a *block* must be
  `padding`, never `margin`. CodeMirror's height map is built from border-box rects and assumes
  blocks stack flush, so a vertical margin between two blocks is invisible to it and every click
  below that gap lands one or two rows low. [README › Live Preview geometry](README.md) has the
  details; `web/tests/editorSpacing.test.ts` fails CI if a margin reappears.
- Match the style, naming, and comment density of the surrounding code.

## Development setup

Requires **Node ≥ 20** and `git` (+ `git-lfs` if you use LFS).

```bash
npm install
npm run dev          # server :8787 + web dev server :5173 (proxied)
```

Before opening a PR:

```bash
npm run typecheck    # must pass — CI runs this
npm run build        # must succeed — CI runs this
```

## Pull requests

1. Fork and create a topic branch off `main`.
2. Make your change; keep commits focused and the diff minimal.
3. Ensure `npm run typecheck` and `npm run build` pass.
4. Update PRD.md / IMPLEMENTATION_PLAN.md if your change touches design or scope.
5. Open the PR using the template; describe the *what* and the *why*.

## Reporting bugs & requesting features

Use the GitHub issue templates. For security issues, **do not** open a public issue —
see [SECURITY.md](SECURITY.md).

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
