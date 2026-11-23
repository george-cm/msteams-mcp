/**
 * Every registered tool must declare MCP annotations so clients can tell
 * read-only tools from mutating and destructive ones.
 */

import { describe, it, expect } from 'vitest';
import { getToolDefinitions } from './registry.js';

const DESTRUCTIVE_TOOLS = new Set([
  'teams_delete_message',
  'teams_edit_message',
  'teams_submission_action',
  'teams_login',
  'teams_remove_favorite',
  'teams_unsave_message',
  'teams_remove_reaction',
]);

describe('tool annotations', () => {
  it('every tool defines readOnlyHint and destructiveHint', () => {
    for (const tool of getToolDefinitions()) {
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.destructiveHint, tool.name).toBe('boolean');
    }
  });

  it('marks exactly the destructive tools', () => {
    const destructive = getToolDefinitions()
      .filter(t => t.annotations?.destructiveHint)
      .map(t => t.name);
    expect(destructive.sort()).toEqual([...DESTRUCTIVE_TOOLS].sort());
  });

  it('no destructive tool is also read-only', () => {
    for (const tool of getToolDefinitions()) {
      if (tool.annotations?.destructiveHint) {
        expect(tool.annotations.readOnlyHint, tool.name).toBe(false);
      }
    }
  });
});
