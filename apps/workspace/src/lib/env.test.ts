import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests, getEnv } from './env';

/** 32 bytes in standard base64, as `openssl rand -base64 32` prints it. */
const KEY_32 = Buffer.alloc(32, 7).toString('base64');

const VALID = {
  OIDC_ISSUER: 'https://auth.test',
  OIDC_CLIENT_ID: 'client-123',
  OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
  OIDC_AUDIENCE: 'project-1',
  WORKSPACE_PUBLIC_URL: 'https://app.test',
  API_INTERNAL_URL: 'http://api:3001',
  VALKEY_URL: 'redis://:s3cret-pass@valkey:6379',
  SESSION_ENC_KEY: KEY_32,
} as const;

type Name =
  keyof typeof VALID | 'SESSION_ENC_KEY_ID' | 'OIDC_STATE_VALKEY_URL' | 'BOS_DEV_LOGIN_RATE_LIMIT';

function stubAll(overrides: Partial<Record<Name, string | undefined>> = {}) {
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

  it('returns the validated values, with defaults for the key id and the OIDC state Valkey', () => {
    stubAll();
    expect(getEnv()).toEqual({
      ...VALID,
      SESSION_ENC_KEY_ID: 'k1',
      OIDC_STATE_VALKEY_URL: VALID.VALKEY_URL,
    });
  });

  it('takes an explicit key id and a dedicated OIDC state Valkey', () => {
    stubAll({ SESSION_ENC_KEY_ID: 'k2', OIDC_STATE_VALKEY_URL: 'redis://:pw@valkey-oidc:6379' });
    expect(getEnv()).toMatchObject({
      SESSION_ENC_KEY_ID: 'k2',
      OIDC_STATE_VALKEY_URL: 'redis://:pw@valkey-oidc:6379',
    });
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

  describe('SESSION_ENC_KEY', () => {
    it('is required', () => {
      stubAll({ SESSION_ENC_KEY: undefined });
      expect(() => getEnv()).toThrow(/SESSION_ENC_KEY is missing/);
      __resetEnvForTests();
      // Compose passes `${SESSION_ENC_KEY:-}`, so an unset key arrives as an empty string.
      stubAll({ SESSION_ENC_KEY: '' });
      expect(() => getEnv()).toThrow(/SESSION_ENC_KEY is required/);
    });

    it.each([
      ['16 bytes', Buffer.alloc(16, 7).toString('base64')],
      ['33 bytes', Buffer.alloc(33, 7).toString('base64')],
      ['base64url instead of base64', Buffer.alloc(32, 0xfb).toString('base64url')],
      ['missing padding', KEY_32.replace(/=+$/, '')],
      ['not base64 at all', 'not-a-key-but-a-long-enough-sentence-of-text!!'],
    ])('rejects %s and never echoes the value', (_label, value) => {
      stubAll({ SESSION_ENC_KEY: value });
      let message = '';
      try {
        getEnv();
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/SESSION_ENC_KEY must be base64 that decodes to exactly 32 bytes/);
      expect(message).not.toContain(value);
    });
  });

  it('rejects a key id that could break the stored value format', () => {
    stubAll({ SESSION_ENC_KEY_ID: 'k.1' });
    expect(() => getEnv()).toThrow(/SESSION_ENC_KEY_ID/);
  });

  it('requires a redis URL for the OIDC state Valkey', () => {
    stubAll({ OIDC_STATE_VALKEY_URL: 'http://valkey-oidc:6379' });
    expect(() => getEnv()).toThrow(/OIDC_STATE_VALKEY_URL must be a redis/);
  });

  describe('BOS_DEV_LOGIN_RATE_LIMIT', () => {
    it('is absent by default', () => {
      stubAll();
      expect(getEnv().BOS_DEV_LOGIN_RATE_LIMIT).toBeUndefined();
    });

    it('is accepted as a number on a *.localhost public URL, even in a production build', () => {
      // The compose `app` profile runs a production build on app.localhost and must keep working.
      vi.stubEnv('NODE_ENV', 'production');
      stubAll({ WORKSPACE_PUBLIC_URL: 'https://app.localhost', BOS_DEV_LOGIN_RATE_LIMIT: '200' });
      expect(getEnv().BOS_DEV_LOGIN_RATE_LIMIT).toBe(200);
    });

    it('is accepted on plain localhost', () => {
      stubAll({ WORKSPACE_PUBLIC_URL: 'https://localhost', BOS_DEV_LOGIN_RATE_LIMIT: '50' });
      expect(getEnv().BOS_DEV_LOGIN_RATE_LIMIT).toBe(50);
    });

    it.each(['https://app.example.com', 'https://notlocalhost', 'https://app.localhost.evil.test'])(
      'is refused when the public URL is %s',
      (url) => {
        stubAll({ WORKSPACE_PUBLIC_URL: url, BOS_DEV_LOGIN_RATE_LIMIT: '200' });
        expect(() => getEnv()).toThrow(
          /BOS_DEV_LOGIN_RATE_LIMIT is dev-only and is refused in production/,
        );
      },
    );

    it('is refused on a public URL that merely has localhost in its credentials or path', () => {
      stubAll({
        WORKSPACE_PUBLIC_URL: 'https://app.localhost@app.example.com/x.localhost',
        BOS_DEV_LOGIN_RATE_LIMIT: '200',
      });
      expect(() => getEnv()).toThrow(/refused in production/);
    });

    it.each(['20', '0', '-5', '10001', '21.5', 'abc'])('rejects %s', (value) => {
      stubAll({ WORKSPACE_PUBLIC_URL: 'https://app.localhost', BOS_DEV_LOGIN_RATE_LIMIT: value });
      expect(() => getEnv()).toThrow(/BOS_DEV_LOGIN_RATE_LIMIT/);
    });

    it('accepts the bounds 21 and 10000', () => {
      stubAll({ WORKSPACE_PUBLIC_URL: 'https://app.localhost', BOS_DEV_LOGIN_RATE_LIMIT: '21' });
      expect(getEnv().BOS_DEV_LOGIN_RATE_LIMIT).toBe(21);
      __resetEnvForTests();
      stubAll({ WORKSPACE_PUBLIC_URL: 'https://app.localhost', BOS_DEV_LOGIN_RATE_LIMIT: '10000' });
      expect(getEnv().BOS_DEV_LOGIN_RATE_LIMIT).toBe(10_000);
    });
  });
});
