/**
 * Tests that the whole config directory is isolated in tests: every path
 * derived in paths.ts must resolve under the per-worker temp dir created
 * by src/__fixtures__/isolated-config-dir.ts, never under the real user
 * profile.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { CONFIG_DIR, SESSION_STATE_PATH, TOKEN_CACHE_PATH, KEY_PATH } from './paths.js';
import { ISOLATED_HOME, REAL_APPDATA, REAL_HOME, REAL_USERPROFILE } from '../__fixtures__/isolated-config-dir.js';

function isUnder(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

describe('config dir isolation', () => {
  it('resolves all config paths under the isolated temp home', () => {
    for (const p of [CONFIG_DIR, SESSION_STATE_PATH, TOKEN_CACHE_PATH, KEY_PATH]) {
      expect(isUnder(p, ISOLATED_HOME), p).toBe(true);
    }
  });

  it('does not resolve config paths under the real user profile', () => {
    for (const real of [REAL_APPDATA, REAL_HOME, REAL_USERPROFILE]) {
      if (!real) continue;
      for (const p of [CONFIG_DIR, SESSION_STATE_PATH, TOKEN_CACHE_PATH, KEY_PATH]) {
        expect(isUnder(p, real), `${p} must not be under ${real}`).toBe(false);
        expect(p === real).toBe(false);
      }
    }
  });
});
