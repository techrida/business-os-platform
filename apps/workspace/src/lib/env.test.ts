import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests, getEnv } from './env';

const VALID = {
  OIDC_ISSUER: 'https://auth.test',
  OIDC_CLIENT_ID: 'client-123',
  OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
  OIDC_AUDIENCE: 'project-1',
  WORKSPACE_PUBLIC_URL: 'https://app.test',
  API_INTERNAL_URL: 'http://api:3001',
  VALKEY_URL: 'redis://:s3cret-pass@valkey:6379',
} as const;

function stubAll(overrides: Partial<Record<keyof typeof VALID, string | undefined>> = {}) {
  for (const [name, value] of Object.entries({ ...VALID, ...overrides })) {
    vi.stubEnv(name, value);
  }
}

describe('getEnv', () => {
  beforeEach(() => {
    __resetEnvForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetEnvForTests();
  });

  it('returns the validated values', () => {
    stubAll();
    expect(getEnv()).toEqual(VALID);
  });

  it('validates once and caches the result', () => {
    stubAll();
    const first = getEnv();
    vi.stubEnv('OIDC_CLIENT_ID', 'changed');
    expect(getEnv()).toBe(first);
    expect(getEnv().OIDC_CLIENT_ID).toBe('client-123');
  });

  it('names a missing variable in the error', () => {
    stubAll({ OIDC_AUDIENCE: undefined });
    expect(() => getEnv()).toThrow(/OIDC_AUDIENCE is missing/);
  });

  it('names every bad variable and never echoes a value', () => {
    stubAll({ VALKEY_URL: 'http://:s3cret-pass@valkey', OIDC_CLIENT_ID: undefined });
    let message = '';
    try {
      getEnv();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/VALKEY_URL/);
    expect(message).toMatch(/OIDC_CLIENT_ID is missing/);
    expect(message).not.toContain('s3cret-pass');
  });

  it('requires https for the browser-facing URLs', () => {
    stubAll({ OIDC_ISSUER: 'http://auth.test' });
    expect(() => getEnv()).toThrow(/OIDC_ISSUER must be an absolute https URL/);
    __resetEnvForTests();
    stubAll({ WORKSPACE_PUBLIC_URL: 'http://app.test' });
    expect(() => getEnv()).toThrow(/WORKSPACE_PUBLIC_URL/);
  });

  it('does not cache a failure', () => {
    stubAll({ OIDC_ISSUER: undefined });
    expect(() => getEnv()).toThrow();
    stubAll();
    expect(getEnv().OIDC_ISSUER).toBe('https://auth.test');
  });
});
