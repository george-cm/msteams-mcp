---
type: Convention
title: GitHub workflow for the msteams-mcp fork
description: Work lands on george-cm/msteams-mcp; no upstream remote; always gh --repo; main protected by ruleset; PR + CI + merge commit
tags: [git, github, gh, ci, fork]
status: stable
stale_after: 2027-05-27
---

# GitHub workflow for the msteams-mcp fork

**Recorded 2026-11-27.**

## Rules

- Work lands on the fork [george-cm/msteams-mcp](https://github.com/george-cm/msteams-mcp). The source project [m0nkmaster/msteams-mcp](https://github.com/m0nkmaster/msteams-mcp) only gets changes George deliberately sends upstream.
- Always pass `--repo george-cm/msteams-mcp` to every `gh` command (`pr create`, `pr view`, `pr merge`, `run list`, `run watch`, `pr checks`).
- Never re-add an `upstream` git remote. Never run `gh repo set-default` or change git config to work around this.
- To pull in upstream changes: `gh repo sync george-cm/msteams-mcp` (runs on GitHub, no remote needed), then `git pull --ff-only` on `main`.
- Branch per task, in its own worktree under `.worktrees/` (gitignored), created from `main`.

## Why there is no upstream remote

The clone had an `upstream` remote marked `gh-resolved base`, so `gh` treated upstream as the default repo. On 2026-11-27 `gh pr create` without `--repo` opened a fork PR on upstream (m0nkmaster/msteams-mcp#68). It was closed within minutes as a mistake. A GitGuardian bot comment on it flagged a fake unsigned test JWT in `src/auth/token-refresh-http.test.ts` (upstream's own code, not a real secret). The remote was removed the same day.

If a remote is ever needed again: `git remote add upstream git@github.com:m0nkmaster/msteams-mcp.git`; when `gh` asks for a default, pick the fork.

## `main` protection

- Ruleset `protect-main` (id 28160018), active since 2026-11-26.
- A PR is required with 0 approvals (GitHub does not allow approving your own PR). No direct pushes.
- Required status checks: `test (20.19)` and `test (22.12)` (`.github/workflows/ci.yml`). Strict mode is off.
- No force-push and no deletion of `main`.
- Merge with a merge commit (keeps per-commit review history). Merging needs George's explicit yes.

## CI

- CI runs on pushes to `main` and on PRs into `main` only. It has no `workflow_dispatch` trigger, so `gh workflow run` can't start it.
- Before 2026-11-26 Actions never ran on the fork: GitHub holds workflows on new forks until someone clicks "I understand my workflows, go ahead and enable them" on the Actions tab. The API showed `enabled: true` the whole time.
- Wait for a run: `gh run watch <id> --repo george-cm/msteams-mcp --exit-status`.
