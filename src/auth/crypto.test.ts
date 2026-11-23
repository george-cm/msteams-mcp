/**
 * Unit tests for encryption utilities.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encrypt, decrypt, _setKeyStoreForTesting, type EncryptedData, type KeyProtector } from './crypto.js';

describe('encrypt/decrypt round-trip', () => {
  it('encrypts and decrypts a simple string', () => {
    const plaintext = 'hello world';
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts JSON data', () => {
    const data = JSON.stringify({ token: 'abc123', expiry: 1705850000 });
    const encrypted = encrypt(data);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(data);
  });

  it('encrypts and decrypts empty string', () => {
    const encrypted = encrypt('');
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe('');
  });

  it('encrypts and decrypts unicode content', () => {
    const text = 'Hello 🌍 — "quotes" & <tags>';
    const encrypted = encrypt(text);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(text);
  });

  it('produces different ciphertext for same plaintext (unique IV)', () => {
    const plaintext = 'same input';
    const encrypted1 = encrypt(plaintext);
    const encrypted2 = encrypt(plaintext);
    // IVs should differ, so ciphertext differs
    expect(encrypted1.iv).not.toBe(encrypted2.iv);
    expect(encrypted1.content).not.toBe(encrypted2.content);
  });
});

describe('decrypt error handling', () => {
  it('throws on tampered ciphertext', () => {
    const encrypted = encrypt('secret');
    const tampered: EncryptedData = {
      ...encrypted,
      content: encrypted.content.slice(0, -2) + 'xx',
    };
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws on tampered auth tag', () => {
    const encrypted = encrypt('secret');
    const tampered: EncryptedData = {
      ...encrypted,
      tag: 'a'.repeat(encrypted.tag.length),
    };
    expect(() => decrypt(tampered)).toThrow();
  });
});

describe('v2 key store', () => {
  let tmpDir: string;
  let keyPath: string;

  /** Deterministic stub protector: XOR with a fixed byte, reversed. */
  const stubProtector: KeyProtector = {
    protect: (data: Buffer) => Buffer.from(data.map(b => b ^ 0xa5).reverse()),
    unprotect: (data: Buffer) => Buffer.from(data.map(b => b ^ 0xa5).reverse()),
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-mcp-crypto-'));
    keyPath = path.join(tmpDir, 'key.dpapi');
    _setKeyStoreForTesting({ protector: stubProtector, keyPath });
  });

  afterEach(() => {
    _setKeyStoreForTesting(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips with the v2 key', () => {
    const plaintext = 'secret tokens';
    const encrypted = encrypt(plaintext);
    expect(encrypted.version).toBe(2);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it('still decrypts version 1 blobs', () => {
    _setKeyStoreForTesting({ protector: null, keyPath });
    const v1 = encrypt('legacy secret');
    expect(v1.version).toBe(1);

    _setKeyStoreForTesting({ protector: stubProtector, keyPath });
    expect(decrypt(v1)).toBe('legacy secret');
  });

  it('creates the key file only when absent and reuses it on next load', () => {
    expect(fs.existsSync(keyPath)).toBe(false);
    encrypt('first');
    expect(fs.existsSync(keyPath)).toBe(true);
    const blob = fs.readFileSync(keyPath, 'utf8');
    const ciphertext = encrypt('remember me');

    // Simulate a fresh process: reset cache; existing blob must be reused.
    _setKeyStoreForTesting({ protector: stubProtector, keyPath });
    expect(decrypt(ciphertext)).toBe('remember me');
    expect(fs.readFileSync(keyPath, 'utf8')).toBe(blob);
  });

  it('falls back to v1 when the protector throws and leaves the key file untouched', () => {
    encrypt('first');
    const blob = fs.readFileSync(keyPath, 'utf8');

    _setKeyStoreForTesting({
      protector: {
        protect: () => { throw new Error('powershell failed'); },
        unprotect: () => { throw new Error('powershell failed'); },
      },
      keyPath,
    });

    const encrypted = encrypt('fallback');
    expect(encrypted.version).toBe(1);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe(blob);
  });

  it('emits v1 when the protector is null', () => {
    _setKeyStoreForTesting({ protector: null, keyPath });
    const encrypted = encrypt('plain legacy');
    expect(encrypted.version).toBe(1);
    expect(decrypt(encrypted)).toBe('plain legacy');
    expect(fs.existsSync(keyPath)).toBe(false);
  });

  it('throws when decrypting v2 data with no key available', () => {
    const encrypted = encrypt('wrapped');
    expect(encrypted.version).toBe(2);

    _setKeyStoreForTesting({ protector: null, keyPath });
    expect(() => decrypt(encrypted)).toThrow();
  });
});
