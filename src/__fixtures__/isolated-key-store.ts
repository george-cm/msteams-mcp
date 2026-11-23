/**
 * Test isolation for the crypto key store.
 *
 * Registered as a vitest setup file: before every test the key protector is
 * replaced with null and the key path pointed at a temp directory, so tests
 * can never read, create or overwrite the real %APPDATA%\teams-mcp-server\
 * key.dpapi (nor trigger a real DPAPI call). Individual tests opt back into
 * a stubbed protector via _setKeyStoreForTesting; the next test's beforeEach
 * re-isolates.
 */

import { beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { _setKeyStoreForTesting } from '../auth/crypto.js';

const ISOLATED_KEY_DIR = mkdtempSync(join(tmpdir(), 'teams-mcp-test-keys-'));

beforeEach(() => {
  _setKeyStoreForTesting({ protector: null, keyPath: join(ISOLATED_KEY_DIR, 'key.dpapi') });
});

afterAll(() => {
  rmSync(ISOLATED_KEY_DIR, { recursive: true, force: true });
});
