---
type: Decision
title: Reviewing fork PRs
description: Post the review first and offer to push fixes; never push substantive rework to a contributor's branch unannounced
tags: [github, review, process]
status: stable
stale_after: 2027-05-23
---

# Reviewing fork PRs

Decided 2026-11-23 (PR #1, valiholban).

- `maintainerCanModify: true` lets us push to the contributor's branch. Use it for small finishing touches, or when the author agrees or has gone quiet.
- For substantive rework, post the review (inline comments where the line is in the diff, the rest in the body) and offer to push fixes. Wait for the author.
- Never push a branch that contains `REVIEW.md` to the contributor's branch. Put fixes on a clean branch from the PR head.
- Review notes and continuation files live on `notes/*` branches, never `main` (this repo is a fork of public upstream).
- Treat the author's "all addressed" reply as a claim: re-review the incremental diff and re-run the reproductions.
