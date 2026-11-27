---
type: Decision
title: CLI message input - --content-file and bare-value conflicts
description: Multi-line text goes through --content-file (npm run on Windows cuts at the first newline); a bare value plus the same flag is a usage error
tags: [cli, windows, content-file, usage-error]
status: stable
stale_after: 2027-05-27
---

# CLI message input: --content-file and bare-value conflicts

**Decided 2026-11-27.** Merged in [PR #5](https://github.com/george-cm/msteams-mcp/pull/5) (`a16633c`) and [PR #10](https://github.com/george-cm/msteams-mcp/pull/10) (`35ae512`).

## The trap

On Windows, `npm run cli -- ...` goes through `cmd.exe`, which cuts the argument list at the first newline. A multi-line message arrived as its first paragraph only, every later flag (including `--files`) was dropped, and the CLI still printed `ok` (self-notes message `1795690349453`, 2026-11-26).

## Decisions

- **`--content-file <path|->`** on tools with a string `content` parameter (`send_message`, `edit_message`). `-` reads stdin. Live-verified 2026-11-27 through `npm run` (messages `1795775604259` with two files, `1795775678411` via stdin).
  - Text and `--content-file` together is a usage error; so is an empty file.
  - UTF-8 and UTF-16 (BOM) decoded; NUL bytes without a BOM refused instead of sending garbage. 4 MB cap.
  - Relative paths resolve from `INIT_CWD` under `npm run`.
  - Path guard mirrors `--files`: credential directories (`.git`, `.ssh`, `.aws`, `.azure`, `.gnupg`, `.docker`, `.kube`) refused at any depth, dot-files refused anywhere, dot-directories refused outside home and as direct children of home. Reason: a prompt-injected agent must not be able to post `~/.ssh/id_rsa` into a chat.
- **Bare value + the same parameter as a flag is a usage error (exit 2).** Before, the flag silently won and the bare value was discarded. Worst case: `edit_message "new text" --conversationId X ...` - the bare value maps to the first required string (`conversationId`), not `content`. The error names the parameter, lists still-missing required flags, and shows the flag hint.
  - Deliberately reverses upstream's pinned "explicit flag wins" test (#50). A future upstream sync may conflict on that test.
  - CLI only: MCP clients never go through `parseToolArgs`.

## Still true

- Any multi-line flag other than message text is still cut under `npm run` on Windows. Use `--content-file`, or call `node node_modules/tsx/dist/cli.mjs src/cli.ts ...` directly.
