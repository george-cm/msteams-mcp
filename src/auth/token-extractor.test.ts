/**
 * Tests for messaging cookie selection across Teams hosts — the authtoken
 * moved to teams.cloud.microsoft while skypetoken_asm stayed on
 * .asyncgw.teams.microsoft.com, so domain filtering must match TEAMS_HOSTS
 * (incl. subdomains) and pick the freshest JWT.
 */
import { describe, it, expect } from 'vitest';
import { extractMessageAuth, getMessageAuthStatus, extractRegionConfig } from './token-extractor.js';
import type { SessionState } from './session-store.js';

function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `eyJhbGciOiJub25lIn0.${body}.sig`;
}

const EXP_FRESH = Math.floor(Date.now() / 1000) + 60 * 60;
const EXP_STALE = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 14;

function skypeJwt(exp: number): string {
  return fakeJwt({ exp, skypeid: 'orgid:00000000-0000-0000-0000-000000000000' });
}
function authJwt(exp: number): string {
  return fakeJwt({ exp, oid: '00000000-0000-0000-0000-000000000000' });
}

function cookie(name: string, value: string, domain: string): SessionState['cookies'][number] {
  return { name, value, domain };
}

describe('extractMessageAuth', () => {
  it('finds authtoken on teams.cloud.microsoft and skypetoken on a Teams subdomain', () => {
    const state: SessionState = {
      cookies: [
        cookie('skypetoken_asm', skypeJwt(EXP_FRESH), '.asyncgw.teams.microsoft.com'),
        cookie('authtoken', encodeURIComponent(authJwt(EXP_FRESH)), 'teams.cloud.microsoft'),
      ],
      origins: [],
    };
    const auth = extractMessageAuth(state);
    expect(auth).not.toBeNull();
    expect(auth?.userMri).toContain('8:orgid:');
  });

  it('picks the freshest authtoken when the same name exists on two Teams hosts', () => {
    const stale = authJwt(EXP_STALE);
    const fresh = authJwt(EXP_FRESH);
    const state: SessionState = {
      cookies: [
        cookie('skypetoken_asm', skypeJwt(EXP_FRESH), '.asyncgw.teams.microsoft.com'),
        cookie('authtoken', encodeURIComponent(stale), 'teams.microsoft.com'),
        cookie('authtoken', encodeURIComponent(fresh), 'teams.cloud.microsoft'),
      ],
      origins: [],
    };
    const auth = extractMessageAuth(state);
    expect(auth).not.toBeNull();
    expect(auth?.authToken).toBe(fresh);
  });

  it('returns null and status hasToken=false when no authtoken exists anywhere', () => {
    const state: SessionState = {
      cookies: [
        cookie('skypetoken_asm', skypeJwt(EXP_FRESH), '.asyncgw.teams.microsoft.com'),
      ],
      origins: [],
    };
    expect(extractMessageAuth(state)).toBeNull();
    expect(getMessageAuthStatus(state).hasToken).toBe(false);
  });
});

describe('extractRegionConfig', () => {
  const goodItem = {
    middleTier: 'https://teams.microsoft.com/api/mt/part/amer-02',
    chatServiceAfd: 'https://teams.microsoft.com/api/chatsvc/amer',
    chatSvcAggAfd: 'https://teams.microsoft.com/api/csa/amer',
  };

  function regionState(item: Record<string, string>): SessionState {
    return {
      cookies: [],
      origins: [{
        origin: 'https://teams.microsoft.com',
        localStorage: [{ name: 'DISCOVER-REGION-GTM', value: JSON.stringify({ item }) }],
      }],
    };
  }

  it('accepts trusted Teams URLs', () => {
    const config = extractRegionConfig(regionState(goodItem));
    expect(config).toMatchObject({
      region: 'amer',
      partition: '02',
      regionPartition: 'amer-02',
      hasPartition: true,
      chatServiceUrl: goodItem.chatServiceAfd,
      csaServiceUrl: goodItem.chatSvcAggAfd,
      teamsBaseUrl: 'https://teams.microsoft.com',
    });
  });

  it('accepts a Teams subdomain and teams.cloud.microsoft URLs', () => {
    const config = extractRegionConfig(regionState({
      ...goodItem,
      chatServiceAfd: 'https://asyncgw.teams.microsoft.com/api/chatsvc/amer',
      chatSvcAggAfd: 'https://teams.cloud.microsoft/api/csa/amer',
    }));
    expect(config).not.toBeNull();
    expect(config?.teamsBaseUrl).toBe('https://asyncgw.teams.microsoft.com');
    expect(config?.csaServiceUrl).toBe('https://teams.cloud.microsoft/api/csa/amer');
  });

  it.each([
    'https://evil.example/api/chatsvc/amer',
    'https://teams.microsoft.com.evil.example/api/chatsvc/amer',
    'http://teams.microsoft.com/api/chatsvc/amer',
    'https://teams.microsoft.com:8443/api/chatsvc/amer',
    'https://user:pass@teams.microsoft.com/api/chatsvc/amer',
    'not a url',
  ])('rejects an untrusted chatServiceAfd: %s', url => {
    expect(extractRegionConfig(regionState({ ...goodItem, chatServiceAfd: url }))).toBeNull();
  });

  it('treats an untrusted middleTier as absent', () => {
    const config = extractRegionConfig(regionState({
      ...goodItem,
      middleTier: 'https://evil.example/api/mt/part/amer-02',
    }));
    expect(config).toMatchObject({
      region: 'amer',
      partition: '',
      regionPartition: 'amer',
      hasPartition: false,
      middleTierUrl: '',
      csaServiceUrl: goodItem.chatSvcAggAfd,
    });
  });

  it('treats an untrusted chatSvcAggAfd as absent and uses the derived fallback', () => {
    const config = extractRegionConfig(regionState({
      ...goodItem,
      chatSvcAggAfd: 'https://teams.microsoft.com.evil.example/api/csa/amer',
    }));
    expect(config?.csaServiceUrl).toBe('https://teams.microsoft.com/api/csa/amer');
  });
});
