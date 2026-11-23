/**
 * File-system locations for teams-mcp-server config.
 *
 * Kept separate from session-store.ts so crypto.ts can reference KEY_PATH
 * without importing session-store (which itself imports crypto).
 */

import * as os from 'os';
import * as path from 'path';

/**
 * User-specific config directory for teams-mcp-server.
 * - Windows: %APPDATA%\teams-mcp-server\
 * - macOS/Linux: ~/.teams-mcp-server/
 */
export const CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'teams-mcp-server')
  : path.join(os.homedir(), '.teams-mcp-server');
export const SESSION_STATE_PATH = path.join(CONFIG_DIR, 'session-state.json');
export const TOKEN_CACHE_PATH = path.join(CONFIG_DIR, 'token-cache.json');
export const KEY_PATH = path.join(CONFIG_DIR, 'key.dpapi');
