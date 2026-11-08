import { describe, expect, it } from 'vitest';

import { ConfigError, isLoopbackHost, loadAppConfig, loadCoreConfig } from './config';

const base = {
  DATABASE_URL: 'postgresql://bos_app:s3cret-pw@postgres:5432/bos',
  VALKEY_URL: 'redis://valkey:6379',
  OIDC_ISSUER: 'https://auth.example.com',
  OIDC_AUDIENCE: '123456789',
  OIDC_CLIENT_ID: 'workspace-client',
};

const prod = { ...base, NODE_ENV: 'production' };

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  return [];
}

describe('loadAppConfig', () => {
  it('parses a valid environment, applies defaults and coerces ports', () => {
    const config = loadAppConfig({ ...base, API_PORT: '4000' });
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      API_PORT: 4000,
      METRICS_PORT: 9464,
      OIDC_AUDIENCE: '123456789',
    });
  });

  it('returns a frozen object', () => {
    const config = loadAppConfig(base);
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      (config as { API_PORT: number }).API_PORT = 1;
    }).toThrow(TypeError);
  });

  it('fails fast and lists every problem', () => {
    const list = problems(() => loadAppConfig({ NODE_ENV: 'staging', API_PORT: 'abc' }));
    const paths = list.map((p) => p.split(':')[0]);
    expect(paths).toEqual(
      expect.arrayContaining([
        'NODE_ENV',
        'API_PORT',
        'DATABASE_URL',
        'VALKEY_URL',
        'OIDC_ISSUER',
        'OIDC_AUDIENCE',
      ]),
    );
  });

  it('never echoes a secret value in the error', () => {
    const list = problems(() =>
      loadAppConfig({ ...base, DATABASE_URL: 'mysql://bos_app:s3cret-pw@postgres/bos' }),
    );
    expect(list.length).toBeGreaterThan(0);
    expect(list.join('\n')).not.toContain('s3cret-pw');
  });

  describe('production rules for OIDC_ISSUER', () => {
    it('accepts an https issuer', () => {
      expect(loadAppConfig(prod).OIDC_ISSUER).toBe('https://auth.example.com');
    });

    it('accepts https://auth.localhost, which the prod-like compose profile needs', () => {
      expect(loadAppConfig({ ...prod, OIDC_ISSUER: 'https://auth.localhost' }).NODE_ENV).toBe(
        'production',
      );
    });

    it('rejects http: in production', () => {
      const list = problems(() =>
        loadAppConfig({ ...prod, OIDC_ISSUER: 'http://auth.example.com' }),
      );
      expect(list).toEqual(['OIDC_ISSUER: must use https: in production']);
    });

    it.each([
      'https://localhost',
      'https://localhost:8443',
      'https://127.0.0.1:9000',
      'https://127.1.2.3',
      'https://[::1]:9000',
      'https://0.0.0.0',
      'https://2130706433',
    ])('rejects the loopback issuer %s in production', (issuer) => {
      const list = problems(() => loadAppConfig({ ...prod, OIDC_ISSUER: issuer }));
      expect(list).toEqual(['OIDC_ISSUER: must not point at a loopback host in production']);
    });

    it('allows an in-process http://127.0.0.1 issuer outside production (the test JWKS style)', () => {
      const config = loadAppConfig({
        ...base,
        NODE_ENV: 'test',
        OIDC_ISSUER: 'http://127.0.0.1:45123',
      });
      expect(config.OIDC_ISSUER).toBe('http://127.0.0.1:45123');
    });

    it('rejects a non-URL issuer everywhere', () => {
      expect(problems(() => loadAppConfig({ ...base, OIDC_ISSUER: 'not a url' }))).toEqual([
        'OIDC_ISSUER: must be an absolute URL',
      ]);
    });
  });

  describe('OIDC_ALLOWED_AZP (the clients whose tokens the API accepts)', () => {
    it('defaults to OIDC_CLIENT_ID, the workspace client', () => {
      expect(loadAppConfig(base).OIDC_ALLOWED_AZP).toEqual(['workspace-client']);
    });

    it('parses a comma-separated list, trimming blanks and empty entries', () => {
      const config = loadAppConfig({ ...base, OIDC_ALLOWED_AZP: ' web-1 , k6-user,, ' });
      expect(config.OIDC_ALLOWED_AZP).toEqual(['web-1', 'k6-user']);
    });

    it('replaces the OIDC_CLIENT_ID default when set', () => {
      const config = loadAppConfig({ ...base, OIDC_ALLOWED_AZP: 'k6-user' });
      expect(config.OIDC_ALLOWED_AZP).toEqual(['k6-user']);
    });

    it('is required when OIDC_CLIENT_ID is not set', () => {
      const { OIDC_CLIENT_ID: _drop, ...withoutClient } = base;
      expect(problems(() => loadAppConfig(withoutClient))).toEqual([
        'OIDC_ALLOWED_AZP: must list at least one client id (or set OIDC_CLIENT_ID)',
      ]);
    });

    it('rejects a list with no entries', () => {
      expect(problems(() => loadAppConfig({ ...base, OIDC_ALLOWED_AZP: ' , ' }))).toEqual([
        'OIDC_ALLOWED_AZP: must list at least one client id (or set OIDC_CLIENT_ID)',
      ]);
    });
  });

  it('has no auth-off switch: unknown variables are ignored, missing OIDC settings fail', () => {
    const { OIDC_ISSUER: _drop, ...withoutIssuer } = base;
    const list = problems(() =>
      loadAppConfig({ ...withoutIssuer, UNRELATED_FLAG: 'true', ANOTHER_UNKNOWN: '1' }),
    );
    expect(list.map((p) => p.split(':')[0])).toEqual(['OIDC_ISSUER']);
  });
});

describe('loadCoreConfig (worker)', () => {
  it('needs no OIDC settings and defaults the metrics port to 9465', () => {
    const config = loadCoreConfig(
      { DATABASE_URL: base.DATABASE_URL, VALKEY_URL: base.VALKEY_URL },
      'worker',
    );
    expect(config.METRICS_PORT).toBe(9465);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('still requires Postgres and Valkey', () => {
    const list = problems(() => loadCoreConfig({}, 'worker'));
    expect(list.map((p) => p.split(':')[0])).toEqual(['DATABASE_URL', 'VALKEY_URL']);
  });
});

describe('isLoopbackHost', () => {
  it('flags literal loopbacks only', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST.')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('auth.localhost')).toBe(false);
    expect(isLoopbackHost('auth.example.com')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
  });
});
