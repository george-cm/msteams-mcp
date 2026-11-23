/**
 * Test isolation for the whole config directory.
 *
 * Registered FIRST in vitest setupFiles: it overwrites APPDATA, HOME and
 * USERPROFILE with a per-worker temp directory at load time, before any
 * test file's imports run. paths.ts computes CONFIG_DIR (and therefore
 * SESSION_STATE_PATH, TOKEN_CACHE_PATH and KEY_PATH) at import time from
 * those variables, so every session/token/key/log path a test touches
 * lands under the temp dir — never the real %APPDATA%\teams-mcp-server.
 *
 * The real values are exported so tests can assert paths do NOT resolve
 * under them.
 */

import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export const REAL_APPDATA = process.env.APPDATA;
export const REAL_HOME = process.env.HOME;
export const REAL_USERPROFILE = process.env.USERPROFILE;

/** Per-worker root holding the redirected config directory. */
export const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'teams-mcp-test-home-'));

process.env.APPDATA = join(ISOLATED_HOME, 'AppData', 'Roaming');
process.env.HOME = ISOLATED_HOME;
process.env.USERPROFILE = ISOLATED_HOME;

afterAll(() => {
  for (const [name, value] of [
    ['APPDATA', REAL_APPDATA],
    ['HOME', REAL_HOME],
    ['USERPROFILE', REAL_USERPROFILE],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});
