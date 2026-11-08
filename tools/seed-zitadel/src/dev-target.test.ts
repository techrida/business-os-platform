import { describe, expect, it } from 'vitest';

import { assertDevTarget } from './index.js';

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
});
