/**
 * Encryption utilities for credential storage.
 *
 * Two key versions exist:
 * - version 2: a random 32-byte key stored in `key.dpapi`, wrapped with
 *   Windows DPAPI (CurrentUser scope) so the key material is never on disk
 *   in a derivable form. Falls back to version 1 when no key protector is
 *   available (non-Windows, or DPAPI call failure).
 * - version 1 (legacy): key derived via scrypt from hostname + username.
 *   Kept so existing files remain readable; new writes prefer version 2.
 *
 * DPAPI protects the key file against offline theft (copied files, backups):
 * an attacker who copies the config directory to another machine or account
 * cannot unwrap the key. It does NOT protect against other processes running
 * as the same user — DPAPI unprotects for any process in the same user
 * context.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { KEY_PATH as DEFAULT_KEY_PATH } from './paths.js';
import * as log from '../utils/logger.js';

/** Algorithm for encryption. */
const ALGORITHM = 'aes-256-gcm';

/** Salt for legacy (version 1) key derivation. */
const SALT = 'teams-mcp-credential-salt-v1';

/** DPAPI entropy for the version 2 key blob. */
const DPAPI_ENTROPY = 'teams-mcp-key-v2';

/**
 * Wraps/unwraps key material for storage. Implementations must keep key
 * bytes off the command line - protect/unprotect take data via stdin.
 */
export interface KeyProtector {
  protect(data: Buffer): Buffer;
  unprotect(data: Buffer): Buffer;
}

/**
 * Windows DPAPI protector driven through PowerShell. Key material travels
 * only via stdin/stdout as base64, never through process arguments.
 */
export const dpapiProtector: KeyProtector = {
  protect(data: Buffer): Buffer {
    return runDpapi('Protect', data);
  },
  unprotect(data: Buffer): Buffer {
    return runDpapi('Unprotect', data);
  },
};

/**
 * Absolute path to the Windows PowerShell executable. A bare
 * 'powershell.exe' would be resolved against the current working
 * directory before PATH, which makes it plantable by anything that can
 * write there.
 */
const POWERSHELL_EXE = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
);

/** Test hook: the command and working directory runDpapi invokes. */
export function _dpapiInvocationForTesting(): { command: string; cwd: string | undefined } {
  return { command: POWERSHELL_EXE, cwd: process.env.SystemRoot };
}

function runDpapi(operation: 'Protect' | 'Unprotect', data: Buffer): Buffer {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$input_b64 = [Console]::In.ReadToEnd()',
    '$bytes = [Convert]::FromBase64String($input_b64.Trim())',
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
    `$result = [Security.Cryptography.ProtectedData]::${operation}($bytes, $entropy, 'CurrentUser')`,
    '[Console]::Out.Write([Convert]::ToBase64String($result))',
  ].join('; ');

  const output = execFileSync(
    POWERSHELL_EXE,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { input: data.toString('base64'), encoding: 'utf8', timeout: 30000, windowsHide: true, cwd: process.env.SystemRoot }
  );

  return Buffer.from(output.trim(), 'base64');
}

/** Active protector: DPAPI on Windows, nothing elsewhere. */
let keyProtector: KeyProtector | null = process.platform === 'win32' ? dpapiProtector : null;
let keyPath = DEFAULT_KEY_PATH;

/** Test hook: the key file path currently in effect. */
export function _keyStorePathForTesting(): string {
  return keyPath;
}

/**
 * Version 2 key state: undefined = not loaded yet, Buffer = ready,
 * 'unavailable' = no key protector exists on this platform (use version 1
 * this process). A configured protector that FAILS is never cached as
 * 'unavailable' — the next call retries, so a transient PowerShell error
 * can't pin the process onto the weaker v1 key.
 */
let v2Key: Buffer | 'unavailable' | undefined;

/** Drops the cached v2 key so the next call reloads (or recreates) it. */
export function resetKeyCache(): void {
  v2Key = undefined;
}

/**
 * Test hook: swap the key protector and key file location. Pass null to
 * restore defaults. Always clears the cached key.
 */
export function _setKeyStoreForTesting(
  opts: { protector: KeyProtector | null; keyPath: string } | null
): void {
  keyProtector = opts === null
    ? (process.platform === 'win32' ? dpapiProtector : null)
    : opts.protector;
  keyPath = opts === null ? DEFAULT_KEY_PATH : opts.keyPath;
  v2Key = undefined;
}

/**
 * Loads or creates the version 2 key. On any failure the key file is left
 * untouched (a transient PowerShell failure must not destroy it) and this
 * call falls back to the version 1 key — the failure is not cached, so the
 * next call retries.
 */
function getV2Key(): Buffer | 'unavailable' {
  if (v2Key !== undefined) return v2Key;

  if (!keyProtector) {
    v2Key = 'unavailable';
    return v2Key;
  }

  try {
    if (fs.existsSync(keyPath)) {
      const blob = fs.readFileSync(keyPath, 'utf8');
      v2Key = keyProtector.unprotect(Buffer.from(blob.trim(), 'base64'));
      return v2Key;
    }

    const key = crypto.randomBytes(32);
    const blob = keyProtector.protect(key);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });

    // Atomic creation: link fails with EEXIST if another process created
    // the key first, in which case the existing file is adopted rather
    // than overwritten (each process could otherwise end up encrypting
    // with a key the file no longer holds).
    const tmpPath = `${keyPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, blob.toString('base64'), { mode: 0o600 });
    try {
      fs.linkSync(tmpPath, keyPath);
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST') throw linkError;
      const existing = fs.readFileSync(keyPath, 'utf8');
      v2Key = keyProtector.unprotect(Buffer.from(existing.trim(), 'base64'));
      return v2Key;
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* already linked or never created */ }
    }
    v2Key = key;
    return v2Key;
  } catch (error) {
    // Transient failure (PowerShell error, unreadable file, timeout):
    // report 'unavailable' for this call only — v2Key is left undefined so
    // the next call retries instead of sticking on the legacy key.
    log.warn('crypto', `DPAPI key store unavailable, falling back to legacy key: ${error instanceof Error ? error.message : error}`);
    return 'unavailable';
  }
}

/** True when a version 2 key can be used for encryption in this process. */
export function v2KeyAvailable(): boolean {
  return getV2Key() !== 'unavailable';
}

/** Derives the legacy (version 1) encryption key from machine-specific values. */
function deriveLegacyKey(): Buffer {
  const machineId = `${os.hostname()}:${os.userInfo().username}`;
  return crypto.scryptSync(machineId, SALT, 32);
}

/** Encrypted data format. */
export interface EncryptedData {
  /** Initialisation vector (hex). */
  iv: string;
  /** Encrypted content (hex). */
  content: string;
  /** Authentication tag (hex). */
  tag: string;
  /** Version marker for format compatibility. */
  version: number;
}

function encryptWithKey(plaintext: string, key: Buffer, version: number): EncryptedData {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return {
    iv: iv.toString('hex'),
    content: encrypted,
    tag: cipher.getAuthTag().toString('hex'),
    version,
  };
}

/**
 * Encrypts a string value. Uses the version 2 (DPAPI-wrapped) key when
 * available, otherwise the legacy version 1 key.
 */
export function encrypt(plaintext: string): EncryptedData {
  const key = getV2Key();
  return key === 'unavailable'
    ? encryptWithKey(plaintext, deriveLegacyKey(), 1)
    : encryptWithKey(plaintext, key, 2);
}

/**
 * Decrypts encrypted data.
 *
 * @throws Error if decryption fails (wrong machine, corrupted data, etc.)
 */
export function decrypt(data: EncryptedData): string {
  let key: Buffer;
  if (data.version === 1) {
    key = deriveLegacyKey();
  } else if (data.version === 2) {
    const v2 = getV2Key();
    if (v2 === 'unavailable') {
      throw new Error('Cannot decrypt version 2 data: DPAPI key store unavailable');
    }
    key = v2;
  } else {
    throw new Error(`Unsupported encryption version: ${data.version}`);
  }

  const iv = Buffer.from(data.iv, 'hex');
  const tag = Buffer.from(data.tag, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(data.content, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
