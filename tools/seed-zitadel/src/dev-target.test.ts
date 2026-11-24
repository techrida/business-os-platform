import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertDevTarget, main } from './index.js';
import { EXTRA_VENDORS } from './personas.js';

describe('assertDevTarget', () => {
  it('refuses a production issuer and says what to set', () => {
    expect(() => assertDevTarget('https://auth.techrida.com', {})).toThrow(
      /SEED_ALLOW_NON_LOCAL=1/,
    );
    expect(() => assertDevTarget('https://auth.techrida.com', {})).toThrow(/auth\.techrida\.com/);
  });

  it('accepts *.localhost and localhost, with or without a port', () => {
    expect(() => assertDevTarget('https://auth.localhost', {})).not.toThrow();
    expect(() => assertDevTarget('http://localhost:8080', {})).not.toThrow();
  });

  it('accepts a non-local issuer only when SEED_ALLOW_NON_LOCAL is exactly 1', () => {
    expect(() =>
      assertDevTarget('https://auth.techrida.com', { SEED_ALLOW_NON_LOCAL: '1' }),
    ).not.toThrow();
    expect(() =>
      assertDevTarget('https://auth.techrida.com', { SEED_ALLOW_NON_LOCAL: 'true' }),
    ).toThrow();
  });

  it('is not fooled by a host that merely contains or ends with "localhost"', () => {
    expect(() => assertDevTarget('https://localhost.evil.com', {})).toThrow();
    expect(() => assertDevTarget('https://evillocalhost', {})).toThrow();
    expect(() => assertDevTarget('https://localhost@evil.com', {})).toThrow();
  });

  it('refuses a value that is not a URL', () => {
    expect(() => assertDevTarget('not a url', {})).toThrow(/SEED_ALLOW_NON_LOCAL=1/);
  });

  // R6Q15: the second approved vendor and the vendor awaiting KYC are dev and QA logins. The whole seed is behind this
  // guard, so a production issuer reaches neither their ZITADEL orgs nor their vendor rows.
  describe('main against a production issuer', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('refuses before it reads the PAT file or creates any org, so the extra vendors are never made', async () => {
      vi.stubEnv('OIDC_ISSUER', 'https://auth.techrida.com');
      vi.stubEnv('ZITADEL_API_URL', 'https://auth.techrida.com');
      vi.stubEnv('SEED_ALLOW_NON_LOCAL', '');
      // A missing PAT file or database URL would give a different error: only the guard says "refuses to run".
      vi.stubEnv('ZITADEL_ADMIN_PAT_FILE', '/nonexistent/admin.pat');
      vi.stubEnv('DATABASE_MIGRATE_URL', '');
      await expect(main()).rejects.toThrow(/refuses to run against auth\.techrida\.com/);
      expect(EXTRA_VENDORS.map((v) => v.key)).toEqual(['vendor2', 'vendorpending']);
    });
  });
});
