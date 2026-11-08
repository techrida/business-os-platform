import { describe, expect, it } from 'vitest';

import { ConfigError, isLoopbackHost, loadAppConfig, loadCoreConfig } from './config';

const base = {
  DATABASE_URL: 'postgresql://bos_app:s3cret-pw@postgres:5432/bos',
  VALKEY_URL: 'redis://valkey:6379',
  OIDC_ISSUER: 'https://auth.example.com',
  OIDC_AUDIENCE: '123456789',
  OIDC_CLIENT_ID: 'workspace-client',
};

// Production must state every kernel value itself (no dev defaults, no optional secrets).
const kernelProd = {
  SMTP_URL: 'smtp://smtp.example.com:587',
  MAIL_FROM: 'Business OS <no-reply@example.com>',
  ZITADEL_API_URL: 'https://auth.example.com',
  ZITADEL_PROVISIONER_TOKEN: 'provisioner-token-value',
  WORKSPACE_PUBLIC_URL: 'https://app.example.com',
  PORTAL_PUBLIC_URL: 'https://portal.example.com',
  DOCS_LINK_SECRET: 'd'.repeat(32),
  ZITADEL_ACTIONS_SIGNING_KEY: 'signing-key-value',
};
const prod = { ...base, ...kernelProd, NODE_ENV: 'production' };

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

describe('P1 kernel settings', () => {
  it('gives dev-safe defaults outside production', () => {
    expect(loadAppConfig(base)).toMatchObject({
      FILES_ROOT: '/var/lib/bos/files',
      CLAMD_HOST: 'clamav',
      CLAMD_PORT: 3310,
      SMTP_URL: 'smtp://mailpit:1025',
      MAIL_FROM: 'Business OS <noreply@bos.localhost>',
      ZITADEL_API_URL: 'https://auth.localhost',
    });
  });

  it('leaves the secrets undefined outside production', () => {
    const config = loadAppConfig(base);
    expect(config.DOCS_LINK_SECRET).toBeUndefined();
    expect(config.ZITADEL_PROVISIONER_TOKEN).toBeUndefined();
    expect(config.ZITADEL_ACTIONS_SIGNING_KEY).toBeUndefined();
    expect(config.POSTAL_WEBHOOK_SECRET).toBeUndefined();
  });

  it('gives PORTAL_PUBLIC_URL a dev default and keeps an explicit value', () => {
    expect(loadAppConfig(base).PORTAL_PUBLIC_URL).toBe('https://portal.localhost');
    expect(
      loadCoreConfig({ DATABASE_URL: base.DATABASE_URL, VALKEY_URL: base.VALKEY_URL }, 'worker')
        .PORTAL_PUBLIC_URL,
    ).toBe('https://portal.localhost');
    expect(
      loadAppConfig({ ...base, PORTAL_PUBLIC_URL: 'https://portal.example.com' }).PORTAL_PUBLIC_URL,
    ).toBe('https://portal.example.com');
  });

  it('rejects a PORTAL_PUBLIC_URL that is not an http(s) URL', () => {
    const list = problems(() => loadAppConfig({ ...base, PORTAL_PUBLIC_URL: 'ftp://portal' }));
    expect(list).toEqual(['PORTAL_PUBLIC_URL: must be an http(s) URL']);
  });

  it('keeps POSTAL_WEBHOOK_SECRET optional in production, and refuses a short one without echoing it', () => {
    expect(loadAppConfig(prod).POSTAL_WEBHOOK_SECRET).toBeUndefined();
    const secret = 'p'.repeat(32);
    expect(loadAppConfig({ ...prod, POSTAL_WEBHOOK_SECRET: secret }).POSTAL_WEBHOOK_SECRET).toBe(
      secret,
    );
    const list = problems(() => loadAppConfig({ ...base, POSTAL_WEBHOOK_SECRET: 'short-postal' }));
    expect(list.map((p) => p.split(':')[0])).toEqual(['POSTAL_WEBHOOK_SECRET']);
    expect(list.join('\n')).not.toContain('short-postal');
  });

  it('reads explicit values and coerces CLAMD_PORT', () => {
    const config = loadAppConfig({
      ...base,
      ...kernelProd,
      FILES_ROOT: '/data/files',
      CLAMD_HOST: 'localhost',
      CLAMD_PORT: '3311',
    });
    expect(config).toMatchObject({
      FILES_ROOT: '/data/files',
      CLAMD_HOST: 'localhost',
      CLAMD_PORT: 3311,
      SMTP_URL: kernelProd.SMTP_URL,
      DOCS_LINK_SECRET: kernelProd.DOCS_LINK_SECRET,
    });
  });

  it('requires every kernel value in production and names the missing ones', () => {
    const list = problems(() => loadAppConfig({ ...base, NODE_ENV: 'production' }));
    expect(list).toEqual([
      'SMTP_URL: is required in production',
      'MAIL_FROM: is required in production',
      'ZITADEL_API_URL: is required in production',
      'ZITADEL_PROVISIONER_TOKEN: is required in production',
      'WORKSPACE_PUBLIC_URL: is required in production',
      'PORTAL_PUBLIC_URL: is required in production',
      'DOCS_LINK_SECRET: is required in production',
    ]);
  });

  it('rejects a DOCS_LINK_SECRET under 32 characters without echoing it', () => {
    const list = problems(() => loadAppConfig({ ...base, DOCS_LINK_SECRET: 'short-secret' }));
    expect(list.map((p) => p.split(':')[0])).toEqual(['DOCS_LINK_SECRET']);
    expect(list.join('\n')).not.toContain('short-secret');
  });

  it('rejects a bad SMTP_URL and a bad ZITADEL_API_URL without echoing them', () => {
    const list = problems(() =>
      loadAppConfig({
        ...base,
        SMTP_URL: 'http://user:smtp-pw@mail:25',
        ZITADEL_API_URL: 'ftp://auth',
        MAIL_FROM: 'nobody',
      }),
    );
    expect(list.map((p) => p.split(':')[0])).toEqual(['SMTP_URL', 'MAIL_FROM', 'ZITADEL_API_URL']);
    expect(list.join('\n')).not.toContain('smtp-pw');
  });
});

describe('loadCoreConfig (worker)', () => {
  it('carries the kernel settings the worker needs, but not the API-only secrets', () => {
    const config = loadCoreConfig(
      { DATABASE_URL: base.DATABASE_URL, VALKEY_URL: base.VALKEY_URL },
      'worker',
    );
    expect(config).toMatchObject({ FILES_ROOT: '/var/lib/bos/files', CLAMD_PORT: 3310 });
    expect('DOCS_LINK_SECRET' in config).toBe(false);
  });

  it('requires the worker-side kernel values in production only', () => {
    const list = problems(() =>
      loadCoreConfig(
        { DATABASE_URL: base.DATABASE_URL, VALKEY_URL: base.VALKEY_URL, NODE_ENV: 'production' },
        'worker',
      ),
    );
    expect(list.map((p) => p.split(':')[0])).toEqual([
      'SMTP_URL',
      'MAIL_FROM',
      'ZITADEL_API_URL',
      'ZITADEL_PROVISIONER_TOKEN',
      'WORKSPACE_PUBLIC_URL',
      'PORTAL_PUBLIC_URL',
    ]);
  });

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
