/**
 * Tests for getTeamsOrigin — especially New Teams (teams.cloud.microsoft)
 * SubstrateSearch token selection when multiple origins are present.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getTeamsOrigin, _readSecureForTesting, _writeSecureForTesting, _migrateToV2IfUnchangedForTesting, type SessionState } from './session-store.js';
import { encrypt, decrypt, _setKeyStoreForTesting, type EncryptedData, type KeyProtector } from './crypto.js';

/** Deterministic stub protector: XOR with a fixed byte, reversed. */
const stubProtector: KeyProtector = {
  protect: (data: Buffer) => Buffer.from(data.map(b => b ^ 0xa5).reverse()),
  unprotect: (data: Buffer) => Buffer.from(data.map(b => b ^ 0xa5).reverse()),
};

function makeOrigin(
  origin: string,
  localStorage: SessionState['origins'][number]['localStorage'] = []
): SessionState['origins'][number] {
  return { origin, localStorage };
}

/** Fake JWT: unsigned header.payload.sig with a base64url JSON payload. */
function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `eyJhbGciOiJub25lIn0.${body}.sig`;
}

function makeSubstrateEntry(
  target = 'https://substrate.office.com/SubstrateSearch-Internal.ReadWrite',
  secret = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.sig'
) {
  return {
    name: 'msal-substrate-token',
    value: JSON.stringify({
      credentialType: 'AccessToken',
      target,
      // JWT-shaped secret (header.payload.sig) — extractor only checks prefix
      secret,
    }),
  };
}

function makeChatSvcEntry() {
  return {
    name: 'msal-chatsvc-token',
    value: JSON.stringify({
      credentialType: 'AccessToken',
      target: 'https://chatsvcagg.teams.microsoft.com/.default',
      secret: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJjaGF0In0.sig',
    }),
  };
}

describe('getTeamsOrigin', () => {
  it('prefers the origin that holds a SubstrateSearch token', () => {
    const state: SessionState = {
      cookies: [],
      origins: [
        makeOrigin('https://teams.microsoft.com', [makeChatSvcEntry()]),
        makeOrigin('https://teams.cloud.microsoft', [makeSubstrateEntry()]),
      ],
    };

    const chosen = getTeamsOrigin(state);
    expect(chosen?.origin).toBe('https://teams.cloud.microsoft');
  });

  it('falls back to teams.cloud.microsoft when no Substrate token exists', () => {
    const state: SessionState = {
      cookies: [],
      origins: [
        makeOrigin('https://teams.microsoft.com', [makeChatSvcEntry()]),
        makeOrigin('https://teams.cloud.microsoft', [makeChatSvcEntry()]),
      ],
    };

    const chosen = getTeamsOrigin(state);
    expect(chosen?.origin).toBe('https://teams.cloud.microsoft');
  });

  it('returns teams.microsoft.com when it is the only known origin', () => {
    const state: SessionState = {
      cookies: [],
      origins: [makeOrigin('https://teams.microsoft.com', [makeChatSvcEntry()])],
    };

    const chosen = getTeamsOrigin(state);
    expect(chosen?.origin).toBe('https://teams.microsoft.com');
  });

  it('prefers the origin with the latest-expiring UNEXPIRED JWT over a stale one listed first', () => {
    const expired = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 14; // ~2 weeks ago
    const fresh = Math.floor(Date.now() / 1000) + 60 * 60;
    const state: SessionState = {
      cookies: [],
      origins: [
        makeOrigin('https://teams.microsoft.com', [makeSubstrateEntry(undefined, fakeJwt({ exp: expired }))]),
        makeOrigin('https://teams.cloud.microsoft', [makeSubstrateEntry(undefined, fakeJwt({ exp: fresh }))]),
      ],
    };
    expect(getTeamsOrigin(state)?.origin).toBe('https://teams.cloud.microsoft');
  });

  it('picks the fresh origin even when the stale one is listed second', () => {
    const expired = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 14;
    const fresh = Math.floor(Date.now() / 1000) + 60 * 60;
    const state: SessionState = {
      cookies: [],
      origins: [
        makeOrigin('https://teams.cloud.microsoft', [makeSubstrateEntry(undefined, fakeJwt({ exp: fresh }))]),
        makeOrigin('https://teams.microsoft.com', [makeSubstrateEntry(undefined, fakeJwt({ exp: expired }))]),
      ],
    };
    expect(getTeamsOrigin(state)?.origin).toBe('https://teams.cloud.microsoft');
  });

  it('falls back to the previous behaviour when every JWT is expired', () => {
    const expired = Math.floor(Date.now() / 1000) - 60;
    const state: SessionState = {
      cookies: [],
      origins: [
        makeOrigin('https://teams.microsoft.com', [makeSubstrateEntry(undefined, fakeJwt({ exp: expired }))]),
        makeOrigin('https://teams.cloud.microsoft', [makeChatSvcEntry()]),
      ],
    };
    // Upstream logic: first origin with a SubstrateSearch token.
    expect(getTeamsOrigin(state)?.origin).toBe('https://teams.microsoft.com');
  });

  it('returns null when no Teams origins are present', () => {
    const state: SessionState = {
      cookies: [],
      origins: [makeOrigin('https://login.microsoftonline.com', [])],
    };

    expect(getTeamsOrigin(state)).toBeNull();
  });
});

describe('secure file writes', () => {
  let tmpDir: string;
  let filePath: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-mcp-store-'));
    filePath = path.join(tmpDir, 'token-cache.json');
    return path.join(tmpDir, 'key.dpapi');
  }

  it('writes atomically: no temp file lingers and the payload round-trips', () => {
    const keyPath = setup();
    _setKeyStoreForTesting({ protector: stubProtector, keyPath });

    const data = { substrateToken: 'tok', extractedAt: 42 };
    _writeSecureForTesting(filePath, data);

    expect(fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8')) as EncryptedData;
    expect(onDisk.version).toBe(2);
    expect(JSON.parse(decrypt(onDisk))).toEqual(data);
  });

  it('refuses to overwrite a v2 file while the v2 key is unavailable', () => {
    const keyPath = setup();
    _setKeyStoreForTesting({ protector: stubProtector, keyPath });
    _writeSecureForTesting(filePath, { substrateToken: 'original' });
    const v2Blob = fs.readFileSync(filePath, 'utf8');

    // Key now unavailable: a write must abort rather than downgrade to v1.
    _setKeyStoreForTesting({ protector: null, keyPath });
    expect(() => _writeSecureForTesting(filePath, { substrateToken: 'downgrade' })).toThrow();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(v2Blob);
    expect(fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('overwrites a v1 file even when the v2 key is unavailable', () => {
    const keyPath = setup();
    _setKeyStoreForTesting({ protector: null, keyPath });
    _writeSecureForTesting(filePath, { substrateToken: 'v1data' });
    expect((JSON.parse(fs.readFileSync(filePath, 'utf8')) as EncryptedData).version).toBe(1);
  });

  it('resets the key cache when all local data is cleared', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-mcp-cfg-'));
    const savedEnv = {
      APPDATA: process.env.APPDATA,
      USERPROFILE: process.env.USERPROFILE,
      HOME: process.env.HOME,
    };
    process.env.APPDATA = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.env.HOME = tmpHome;
    try {
      // Re-import so CONFIG_DIR/KEY_PATH resolve inside tmpHome.
      vi.resetModules();
      const store = await import('./session-store.js');
      const cryptoMod = await import('./crypto.js');
      const pathsMod = await import('./paths.js');
      cryptoMod._setKeyStoreForTesting({ protector: stubProtector, keyPath: pathsMod.KEY_PATH });

      expect(cryptoMod.encrypt('first').version).toBe(2);
      expect(fs.existsSync(pathsMod.KEY_PATH)).toBe(true);

      store.clearAllLocalData();
      expect(fs.existsSync(pathsMod.CONFIG_DIR)).toBe(false);

      // Without resetKeyCache() the stale in-memory key would be reused and
      // no key file would be recreated.
      const second = cryptoMod.encrypt('second');
      expect(second.version).toBe(2);
      expect(fs.existsSync(pathsMod.KEY_PATH)).toBe(true);
      expect(cryptoMod.decrypt(second)).toBe('second');
    } finally {
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      vi.resetModules();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('v1 to v2 file migration', () => {
  it('rewrites a v1 file as v2 on read when a protector is available', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-mcp-store-'));
    const filePath = path.join(tmpDir, 'token-cache.json');
    const keyPath = path.join(tmpDir, 'key.dpapi');

    try {
      // Write a v1-encrypted file (no protector).
      _setKeyStoreForTesting({ protector: null, keyPath });
      const cache = { substrateToken: 'tok', substrateTokenExpiry: 1, extractedAt: 2 };
      fs.writeFileSync(filePath, JSON.stringify(encrypt(JSON.stringify(cache))));
      expect((JSON.parse(fs.readFileSync(filePath, 'utf8')) as EncryptedData).version).toBe(1);

      // Read it back through the store with a protector: file becomes v2.
      _setKeyStoreForTesting({ protector: stubProtector, keyPath });
      expect((_readSecureForTesting(filePath))).toEqual(cache);
      const rewritten = JSON.parse(fs.readFileSync(filePath, 'utf8')) as EncryptedData;
      expect(rewritten.version).toBe(2);
    } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips the migration rewrite when the on-disk blob changed after parsing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-mcp-store-'));
    const filePath = path.join(tmpDir, 'token-cache.json');
    const keyPath = path.join(tmpDir, 'key.dpapi');

    try {
      _setKeyStoreForTesting({ protector: null, keyPath });
      const cache = { substrateToken: 'tok', substrateTokenExpiry: 1, extractedAt: 2 };
      const parsed = encrypt(JSON.stringify(cache)); // the blob our "read" saw

      // A second process replaced the file before the migration rewrite.
      const newerBlob = JSON.stringify(encrypt(JSON.stringify({ substrateToken: 'newer' })));
      fs.writeFileSync(filePath, newerBlob);

      _setKeyStoreForTesting({ protector: stubProtector, keyPath });
      _migrateToV2IfUnchangedForTesting(filePath, parsed, cache);

      // The newer blob was left alone — not clobbered by our stale data.
      expect(fs.readFileSync(filePath, 'utf8')).toBe(newerBlob);

      // Control: when the on-disk blob still matches the parse, it migrates.
      _setKeyStoreForTesting({ protector: null, keyPath });
      const parsed2 = encrypt(JSON.stringify(cache));
      fs.writeFileSync(filePath, JSON.stringify(parsed2));
      _setKeyStoreForTesting({ protector: stubProtector, keyPath });
      _migrateToV2IfUnchangedForTesting(filePath, parsed2, cache);
      expect((JSON.parse(fs.readFileSync(filePath, 'utf8')) as EncryptedData).version).toBe(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
