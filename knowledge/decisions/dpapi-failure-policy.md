---
type: Decision
title: DPAPI key-store failure policy
description: What crypto.ts should do when DPAPI fails - proposed during PR #1 round 2, not yet approved by George
tags: [crypto, dpapi, session-store, pr-1]
status: draft
stale_after: 2026-12-07
---

# DPAPI key-store failure policy

**Status:** proposed 2026-11-23. Not yet approved by George.

## Context

PR #1 (valiholban fork) wraps the at-rest AES key with Windows DPAPI (`key.dpapi`, v2). The legacy v1 key is scrypt(hostname:username, public salt), so it's obfuscation, not protection. Round 1 suggested "retry every call" and "never write v1 over an existing v2 file". Round 2 showed both were wrong:

- Retrying on every call with no backoff → a synchronous PowerShell spawn per read or write (1.2-2 s measured, 30 s on a hang).
- The no-overwrite guard → permanent login lockout when DPAPI is broken for good, while new files are still written as v1.

## Proposed policy

| Situation | Action |
|---|---|
| `key.dpapi` unwraps | Use v2. |
| `key.dpapi` definitively cannot be unwrapped (CryptographicException, not a timeout) | Rename to `key.dpapi.bad`, create a fresh key, treat existing v2 files as gone (one re-login). |
| Transient failure (timeout, spawn error) | Cache `{ failedAt }`, return v1-unavailable until `DPAPI_RETRY_BACKOFF_MS` (60 s) passes; log once per window. |
| `protect` itself fails (DPAPI blocked, e.g. Constrained Language Mode) | v1 with a loud warning, same backoff. |
| `keyProtector === null` (non-Windows) | v1. |

Drop the `writeSecure` "refuse to overwrite v2" guard.

## Also required

- Cross-process key freshness: re-read `key.dpapi` text each call (no PowerShell) and reload if it changed or is missing. On a v2 GCM auth failure, reset the cache and retry once.
- `clearAllLocalData`: run `resetKeyCache()` in a `finally`.
