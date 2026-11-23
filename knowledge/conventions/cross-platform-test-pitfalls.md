---
type: Convention
title: Cross-platform test pitfalls
description: CI is Linux-only; Windows-specific paths and short-name TEMP hide bugs that pass locally
tags: [testing, ci, windows, vitest]
status: stable
stale_after: 2027-05-23
---

# Cross-platform test pitfalls

Found in PR #1 round 2 (2026-11-23).

- CI runs only on `ubuntu-latest` (`.github/workflows/ci.yml`). A Windows-only path built with `path.join` gets forward slashes on Linux. Build Windows paths with `path.win32.join`.
- On George's machine `os.tmpdir()` is the 8.3 short name `C:\Users\GEORGE~1.MUR\AppData\Local\Temp`. A string check like "is this path under `%USERPROFILE%`" passes locally by accident and fails for users with long-form TEMP. Compare against the specific real directory, or normalise both sides with `realpath`.
- The real Windows config dir is `%APPDATA%\teams-mcp-server`, not `%USERPROFILE%\.teams-mcp-server`. Snapshot that dir (names and mtimes only) before and after `npm test` to prove isolation.
- Test hooks that return their own copy of a value (e.g. `_dpapiInvocationForTesting`) are circular. Assert the real call via `vi.mock('child_process')`.
