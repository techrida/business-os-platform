import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ConfigError, FieldKeyring, isLoopbackHost, loadAppConfig, loadCoreConfig } from './config';

const base = {
  DATABASE_URL: 'postgresql://bos_app:s3cret-pw@postgres:5432/bos',
  VALKEY_URL: 'redis://valkey:6379',
  OIDC_ISSUER: 'https://auth.example.com',
  OIDC_AUDIENCE: '123456789',
  OIDC_CLIENT_ID: 'workspace-client',
};

// Production must state every kernel value itself (no dev defaults, no optional secrets).
const kernelProd = {
  SMTP_URL: 'smtps://smtp.example.com:465',
  MAIL_FROM: 'Business OS <no-reply@example.com>',
  ZITADEL_API_URL: 'https://auth.example.com',
  ZITADEL_PROVISIONER_TOKEN: 'provisioner-token-value',
  WORKSPACE_PUBLIC_URL: 'https://app.example.com',
  PORTAL_PUBLIC_URL: 'https://portal.example.com',
  DOCS_LINK_SECRET: 'd'.repeat(32),
  ZITADEL_ACTIONS_SIGNING_KEY: 'signing-key-value-with-32-chars!!',
  FIELD_ENC_KEYS: `k1:${randomBytes(32).toString('base64')}`,
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

  it('keeps the exact bytes of a nonblank webhook secret and signing key (no trimming)', () => {
    const postal = `  ${'p'.repeat(32)}  `;
    const signing = ` ${'k'.repeat(32)} `;
    const config = loadAppConfig({
      ...base,
      POSTAL_WEBHOOK_SECRET: postal,
      ZITADEL_ACTIONS_SIGNING_KEY: signing,
    });
    expect(config.POSTAL_WEBHOOK_SECRET).toBe(postal);
    expect(config.ZITADEL_ACTIONS_SIGNING_KEY).toBe(signing);
  });

  it('refuses a ZITADEL_ACTIONS_SIGNING_KEY under 32 characters without echoing it', () => {
    const list = problems(() =>
      loadAppConfig({ ...base, ZITADEL_ACTIONS_SIGNING_KEY: 'short-key-16-chrs' }),
    );
    expect(list.map((p) => p.split(':')[0])).toEqual(['ZITADEL_ACTIONS_SIGNING_KEY']);
    expect(list.join('\n')).not.toContain('short-key-16-chrs');
    expect(
      loadAppConfig({ ...base, ZITADEL_ACTIONS_SIGNING_KEY: 'k'.repeat(32) })
        .ZITADEL_ACTIONS_SIGNING_KEY,
    ).toBe('k'.repeat(32));
  });

  it('refuses a plain smtp:// SMTP_URL in production, in the api and the worker, and keeps it for dev and test', () => {
    const plain = 'smtp://relay-user:relay-pw@smtp.example.com:587';
    const expected = [
      'SMTP_URL: must use smtps:// or smtp:// with requireTLS=true in production (plain smtp:// is not encrypted)',
    ];
    const list = problems(() => loadAppConfig({ ...prod, SMTP_URL: plain }));
    expect(list).toEqual(expected);
    expect(list.join('\n')).not.toContain('relay-pw');
    expect(
      problems(() =>
        loadCoreConfig(
          {
            DATABASE_URL: base.DATABASE_URL,
            VALKEY_URL: base.VALKEY_URL,
            ...kernelProd,
            GOTENBERG_URL: 'https://gotenberg.example.com',
            SMTP_URL: plain,
            NODE_ENV: 'production',
          },
          'worker',
        ),
      ),
    ).toEqual(expected);
    expect(loadAppConfig({ ...prod, SMTP_URL: 'SMTPS://smtp.example.com:465' }).SMTP_URL).toBe(
      'SMTPS://smtp.example.com:465',
    );
    // STARTTLS that cannot be skipped is encrypted too; the compose dev mailbox opts out by name.
    const starttls = 'smtp://smtp.example.com:587?requireTLS=true';
    expect(loadAppConfig({ ...prod, SMTP_URL: starttls }).SMTP_URL).toBe(starttls);
    expect(
      problems(() => loadAppConfig({ ...prod, SMTP_URL: `${plain}?requireTLS=false` })),
    ).toEqual(expected);
    expect(loadAppConfig({ ...prod, SMTP_URL: plain, SMTP_ALLOW_PLAINTEXT: 'true' }).SMTP_URL).toBe(
      plain,
    );
    for (const NODE_ENV of ['development', 'test']) {
      expect(loadAppConfig({ ...base, NODE_ENV, SMTP_URL: plain }).SMTP_URL).toBe(plain);
    }
  });

  it('keeps POSTAL_WEBHOOK_SECRET optional in production, treats blank as unset, and refuses a short one without echoing it', () => {
    expect(loadAppConfig(prod).POSTAL_WEBHOOK_SECRET).toBeUndefined();
    for (const blank of ['', '   ', ' '.repeat(40)]) {
      expect(
        loadAppConfig({ ...base, POSTAL_WEBHOOK_SECRET: blank }).POSTAL_WEBHOOK_SECRET,
      ).toBeUndefined();
      expect(
        loadAppConfig({ ...prod, POSTAL_WEBHOOK_SECRET: blank }).POSTAL_WEBHOOK_SECRET,
      ).toBeUndefined();
    }
    const secret = 'p'.repeat(32);
    expect(loadAppConfig({ ...prod, POSTAL_WEBHOOK_SECRET: secret }).POSTAL_WEBHOOK_SECRET).toBe(
      secret,
    );
    for (const env of [base, prod]) {
      const list = problems(() => loadAppConfig({ ...env, POSTAL_WEBHOOK_SECRET: 'short-postal' }));
      expect(list.map((p) => p.split(':')[0])).toEqual(['POSTAL_WEBHOOK_SECRET']);
      expect(list.join('\n')).not.toContain('short-postal');
    }
  });

  it('treats blank DOCS_LINK_SECRET and ZITADEL_ACTIONS_SIGNING_KEY as unset, and still requires DOCS_LINK_SECRET in production', () => {
    for (const blank of ['', '   ']) {
      expect(loadAppConfig({ ...base, DOCS_LINK_SECRET: blank }).DOCS_LINK_SECRET).toBeUndefined();
      expect(
        loadAppConfig({ ...base, ZITADEL_ACTIONS_SIGNING_KEY: blank }).ZITADEL_ACTIONS_SIGNING_KEY,
      ).toBeUndefined();
      expect(
        loadAppConfig({ ...prod, ZITADEL_ACTIONS_SIGNING_KEY: blank }).ZITADEL_ACTIONS_SIGNING_KEY,
      ).toBeUndefined();
      expect(problems(() => loadAppConfig({ ...prod, DOCS_LINK_SECRET: blank }))).toEqual([
        'DOCS_LINK_SECRET: is required in production',
      ]);
    }
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
      'FIELD_ENC_KEYS: is required in production',
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
      'GOTENBERG_URL',
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

describe('the PDF renderer (Gotenberg)', () => {
  const worker = { DATABASE_URL: base.DATABASE_URL, VALKEY_URL: base.VALKEY_URL };
  const workerProd = { ...worker, ...kernelProd, NODE_ENV: 'production' };

  it('defaults to the compose service and sane limits outside production', () => {
    expect(loadCoreConfig(worker, 'worker')).toMatchObject({
      GOTENBERG_URL: 'http://gotenberg:3000',
      GOTENBERG_TIMEOUT_MS: 30_000,
      GOTENBERG_MAX_BYTES: 20_971_520,
    });
    expect(loadAppConfig(base).GOTENBERG_URL).toBe('http://gotenberg:3000');
  });

  it('is required in the worker in production, and never falls back to the dev URL there', () => {
    expect(problems(() => loadCoreConfig(workerProd, 'worker'))).toEqual([
      'GOTENBERG_URL: is required in production',
    ]);
    const config = loadCoreConfig({ ...workerProd, GOTENBERG_URL: 'http://pdf:3000' }, 'worker');
    expect(config.GOTENBERG_URL).toBe('http://pdf:3000');
  });

  it('is not required of the API in production, which never calls it, and stays undefined there', () => {
    expect(loadAppConfig(prod).GOTENBERG_URL).toBeUndefined();
  });

  it('coerces the limits and refuses a bad URL, a short timeout or a size above the upload cap', () => {
    expect(
      loadCoreConfig(
        { ...worker, GOTENBERG_TIMEOUT_MS: '5000', GOTENBERG_MAX_BYTES: '1048576' },
        'worker',
      ),
    ).toMatchObject({ GOTENBERG_TIMEOUT_MS: 5000, GOTENBERG_MAX_BYTES: 1_048_576 });
    expect(
      problems(() =>
        loadCoreConfig(
          {
            ...worker,
            GOTENBERG_URL: 'ftp://pdf',
            GOTENBERG_TIMEOUT_MS: '10',
            GOTENBERG_MAX_BYTES: '26214401',
          },
          'worker',
        ),
      ).map((p) => p.split(':')[0]),
    ).toEqual(['GOTENBERG_URL', 'GOTENBERG_TIMEOUT_MS', 'GOTENBERG_MAX_BYTES']);
    expect(
      loadCoreConfig({ ...worker, GOTENBERG_MAX_BYTES: '26214400' }, 'worker').GOTENBERG_MAX_BYTES,
    ).toBe(26_214_400);
  });
});

describe('the per-transaction database timeouts', () => {
  const worker = { DATABASE_URL: base.DATABASE_URL, VALKEY_URL: base.VALKEY_URL };

  it('defaults to a 5 s lock wait, a 15 s statement and a 30 s idle transaction in both processes', () => {
    const defaults = {
      DB_LOCK_TIMEOUT_MS: 5_000,
      DB_STATEMENT_TIMEOUT_MS: 15_000,
      DB_IDLE_IN_TX_TIMEOUT_MS: 30_000,
    };
    expect(loadCoreConfig(worker, 'worker')).toMatchObject(defaults);
    expect(loadAppConfig(base)).toMatchObject(defaults);
  });

  it('coerces the values and refuses blanks, zero, fractions and words', () => {
    expect(
      loadCoreConfig(
        {
          ...worker,
          DB_LOCK_TIMEOUT_MS: '2000',
          DB_STATEMENT_TIMEOUT_MS: '20000',
          DB_IDLE_IN_TX_TIMEOUT_MS: '60000',
        },
        'worker',
      ),
    ).toMatchObject({
      DB_LOCK_TIMEOUT_MS: 2_000,
      DB_STATEMENT_TIMEOUT_MS: 20_000,
      DB_IDLE_IN_TX_TIMEOUT_MS: 60_000,
    });
    for (const bad of ['', '0', '1.5', '5s']) {
      expect(
        problems(() =>
          loadCoreConfig(
            {
              ...worker,
              DB_LOCK_TIMEOUT_MS: bad,
              DB_STATEMENT_TIMEOUT_MS: bad,
              DB_IDLE_IN_TX_TIMEOUT_MS: bad,
            },
            'worker',
          ),
        ).map((p) => p.split(':')[0]),
      ).toEqual(['DB_LOCK_TIMEOUT_MS', 'DB_STATEMENT_TIMEOUT_MS', 'DB_IDLE_IN_TX_TIMEOUT_MS']);
    }
  });
});

describe('FIELD_ENC_KEYS (the field-encryption keyring)', () => {
  const key1 = randomBytes(32).toString('base64');
  const key2 = randomBytes(32).toString('base64');

  function ring(env: Record<string, string>): FieldKeyring {
    const keyring = loadAppConfig({ ...base, ...env }).FIELD_ENC_KEYS;
    if (keyring === undefined) throw new Error('expected a keyring');
    return keyring;
  }

  it('is optional outside production and stays undefined when unset or blank', () => {
    expect(loadAppConfig(base).FIELD_ENC_KEYS).toBeUndefined();
    expect(loadAppConfig({ ...base, FIELD_ENC_KEYS: '  ' }).FIELD_ENC_KEYS).toBeUndefined();
  });

  it('is required in production, and a blank value counts as missing', () => {
    const { FIELD_ENC_KEYS: _drop, ...withoutKeys } = prod;
    expect(problems(() => loadAppConfig(withoutKeys))).toEqual([
      'FIELD_ENC_KEYS: is required in production',
    ]);
    expect(problems(() => loadAppConfig({ ...prod, FIELD_ENC_KEYS: '' }))).toEqual([
      'FIELD_ENC_KEYS: is required in production',
    ]);
    expect(loadAppConfig(prod).FIELD_ENC_KEYS).toBeInstanceOf(FieldKeyring);
  });

  it('parses one key and makes it both the active and the fingerprint key', () => {
    const keyring = ring({ FIELD_ENC_KEYS: `k1:${key1}` });
    expect(keyring.activeKid).toBe('k1');
    expect(keyring.fingerprintKid).toBe('k1');
    expect(keyring.kids).toEqual(['k1']);
    expect(keyring.key('k1')).toEqual(Buffer.from(key1, 'base64'));
    expect(keyring.key('k2')).toBeUndefined();
  });

  it('treats blank FIELD_ENC_ACTIVE_KID and FIELD_ENC_FP_KID as unset (compose writes `${VAR:-}`)', () => {
    const keyring = ring({
      FIELD_ENC_KEYS: `k1:${key1}`,
      FIELD_ENC_ACTIVE_KID: '',
      FIELD_ENC_FP_KID: ' ',
    });
    expect(keyring.activeKid).toBe('k1');
    expect(keyring.fingerprintKid).toBe('k1');
  });

  it('parses several keys, trimming blanks, with the active and fingerprint ids named', () => {
    const keyring = ring({
      FIELD_ENC_KEYS: ` k1:${key1} , k2:${key2},`,
      FIELD_ENC_ACTIVE_KID: 'k2',
      FIELD_ENC_FP_KID: 'k1',
    });
    expect(keyring.kids).toEqual(['k1', 'k2']);
    expect(keyring.activeKid).toBe('k2');
    expect(keyring.fingerprintKid).toBe('k1');
    expect(keyring.key('k2')).toEqual(Buffer.from(key2, 'base64'));
  });

  it.each([
    ['no separator', key1, 'FIELD_ENC_KEYS: entry 1 must be <kid>:<base64 of 32 bytes>'],
    ['an empty list', ' , ', 'FIELD_ENC_KEYS: must list at least one key'],
    ['a bad key id', `k 1:${key1}`, 'FIELD_ENC_KEYS: entry 1 has an invalid key id'],
    [
      'a key id over 32 characters',
      `${'k'.repeat(33)}:${key1}`,
      'FIELD_ENC_KEYS: entry 1 has an invalid key id',
    ],
    [
      'a short key',
      `k1:${randomBytes(16).toString('base64')}`,
      'FIELD_ENC_KEYS: entry 1 key must be standard base64 of exactly 32 bytes',
    ],
    [
      'a long key',
      `k1:${randomBytes(33).toString('base64')}`,
      'FIELD_ENC_KEYS: entry 1 key must be standard base64 of exactly 32 bytes',
    ],
    [
      'a non-base64 key',
      `k1:${key1.slice(0, -2)}!=`,
      'FIELD_ENC_KEYS: entry 1 key must be standard base64 of exactly 32 bytes',
    ],
    [
      'a base64url key',
      `k1:${randomBytes(32).toString('base64url')}`,
      'FIELD_ENC_KEYS: entry 1 key must be standard base64 of exactly 32 bytes',
    ],
    ['a repeated key id', `k1:${key1},k1:${key2}`, 'FIELD_ENC_KEYS: entry 2 repeats a key id'],
  ])('refuses %s in every environment, without echoing the value', (_name, value, message) => {
    for (const env of [base, { ...base, NODE_ENV: 'test' }, prod]) {
      const list = problems(() => loadAppConfig({ ...env, FIELD_ENC_KEYS: value }));
      expect(list).toEqual([message]);
      expect(list.join('\n')).not.toContain(key1);
      expect(list.join('\n')).not.toContain(value);
    }
  });

  it('needs FIELD_ENC_ACTIVE_KID and FIELD_ENC_FP_KID once there is more than one key', () => {
    const list = problems(() =>
      loadAppConfig({ ...base, FIELD_ENC_KEYS: `k1:${key1},k2:${key2}` }),
    );
    expect(list).toEqual([
      'FIELD_ENC_ACTIVE_KID: is required when FIELD_ENC_KEYS holds more than one key',
      'FIELD_ENC_FP_KID: is required when FIELD_ENC_KEYS holds more than one key',
    ]);
  });

  it('refuses an active or fingerprint id that names no key', () => {
    const list = problems(() =>
      loadAppConfig({
        ...base,
        FIELD_ENC_KEYS: `k1:${key1}`,
        FIELD_ENC_ACTIVE_KID: 'k9',
        FIELD_ENC_FP_KID: 'k8',
      }),
    );
    expect(list).toEqual([
      'FIELD_ENC_ACTIVE_KID: names no key in FIELD_ENC_KEYS',
      'FIELD_ENC_FP_KID: names no key in FIELD_ENC_KEYS',
    ]);
  });

  it('keeps no key material where a log could print it', () => {
    const raw = `k1:${key1},k2:${key2}`;
    const config = loadAppConfig({
      ...base,
      FIELD_ENC_KEYS: raw,
      FIELD_ENC_ACTIVE_KID: 'k2',
      FIELD_ENC_FP_KID: 'k1',
    });
    const hexKey = Buffer.from(key1, 'base64').toString('hex');
    for (const text of [
      JSON.stringify(config),
      inspect(config, { depth: 10, showHidden: true }),
      String(config.FIELD_ENC_KEYS),
      inspect(config.FIELD_ENC_KEYS, { depth: 10, showHidden: true }),
    ]) {
      for (const secret of [raw, key1, key2, hexKey]) expect(text).not.toContain(secret);
    }
    expect(JSON.stringify(config.FIELD_ENC_KEYS)).toBe(
      '{"activeKid":"k2","fingerprintKid":"k1","kids":["k1","k2"]}',
    );
    expect(Object.isFrozen(config.FIELD_ENC_KEYS)).toBe(true);
  });

  it('is an API-only setting: the worker config never carries it', () => {
    const config = loadCoreConfig(
      {
        DATABASE_URL: base.DATABASE_URL,
        VALKEY_URL: base.VALKEY_URL,
        FIELD_ENC_KEYS: `k1:${key1}`,
      },
      'worker',
    );
    expect('FIELD_ENC_KEYS' in config).toBe(false);
  });
});
