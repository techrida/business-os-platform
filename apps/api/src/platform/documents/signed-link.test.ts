// Signed links: pure logic with an in-memory store and a fake clock.
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CLAIM_TTL_SECONDS, LinkError, SignedLinks, type LinkStore } from './signed-link';

const SECRET = 'a-test-secret-that-is-at-least-32-characters-long';
const VERSION = '3f2b8c1e-7a6d-4e55-9b0c-1d2e3f4a5b6c';

/** Mimics Valkey SET key 1 NX EX ttl, and records what was asked. */
class MemoryStore implements LinkStore {
  readonly keys = new Map<string, number>();
  claim(key: string, ttlSeconds: number): Promise<boolean> {
    if (this.keys.has(key)) return Promise.resolve(false);
    this.keys.set(key, ttlSeconds);
    return Promise.resolve(true);
  }
}

function setup(secret: string | undefined = SECRET) {
  const store = new MemoryStore();
  let now = Date.UTC(2026, 10, 8, 10, 0, 0);
  const links = new SignedLinks(secret, store, () => now);
  return {
    store,
    links,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** The jti claim of a token (the payload is not secret, only signed). */
const jtiOf = (token: string): string =>
  (
    JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as {
      jti: string;
    }
  ).jti;

const kind = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (error) {
    return error instanceof LinkError ? error.kind : `other: ${String(error)}`;
  }
};

describe('SignedLinks', () => {
  it('redeems a fresh link once and returns the version id', async () => {
    const { links, store } = setup();
    const { token, expiresAt } = links.issue(VERSION);
    expect(expiresAt.getTime() - Date.UTC(2026, 10, 8, 10, 0, 0)).toBe(60_000);
    expect(await links.redeem(token)).toBe(VERSION);
    // The claim key is dl:<jti>, kept for 120 s (twice the lifetime).
    const [key, ttl] = [...store.keys.entries()][0] ?? [];
    expect(key).toBe(`dl:${jtiOf(token)}`);
    expect(ttl).toBe(CLAIM_TTL_SECONDS);
  });

  it('gives two links for the same version in the same second different tokens, each usable once', async () => {
    const { links, store } = setup();
    // The clock is frozen, so exp and the version id are identical: only the random jti can tell them apart.
    const a = links.issue(VERSION);
    const b = links.issue(VERSION);
    expect(a.expiresAt).toEqual(b.expiresAt);
    expect(a.token).not.toBe(b.token);
    expect(jtiOf(a.token)).not.toBe(jtiOf(b.token));
    // 16 random bytes, base64url without padding.
    expect(jtiOf(a.token)).toMatch(/^[A-Za-z0-9_-]{22}$/);

    // Redeeming one must not burn the other, and each only works once.
    expect(await links.redeem(a.token)).toBe(VERSION);
    expect(await kind(links.redeem(a.token))).toBe('used');
    expect(await links.redeem(b.token)).toBe(VERSION);
    expect(await kind(links.redeem(b.token))).toBe('used');
    expect(store.keys.size).toBe(2);
  });

  it('refuses a correctly signed payload that has no jti or a malformed one', async () => {
    const { links, store } = setup();
    const exp = Math.floor(Date.UTC(2026, 10, 8, 10, 0, 0) / 1000) + 60;
    const signed = (claims: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
      return `${payload}.${sig}`;
    };
    expect(await kind(links.redeem(signed({ v: 1, u: VERSION, exp })))).toBe('invalid');
    expect(await kind(links.redeem(signed({ v: 1, u: VERSION, exp, jti: '' })))).toBe('invalid');
    expect(await kind(links.redeem(signed({ v: 1, u: VERSION, exp, jti: 'short' })))).toBe(
      'invalid',
    );
    expect(store.keys.size).toBe(0);
  });

  it('refuses the second use', async () => {
    const { links } = setup();
    const { token } = links.issue(VERSION);
    await links.redeem(token);
    expect(await kind(links.redeem(token))).toBe('used');
  });

  it('works at 60 s and refuses at 61 s', async () => {
    const a = setup();
    const t1 = a.links.issue(VERSION).token;
    a.advance(60_000);
    expect(await kind(a.links.redeem(t1))).toBe('ok');

    const b = setup();
    const t2 = b.links.issue(VERSION).token;
    b.advance(61_000);
    expect(await kind(b.links.redeem(t2))).toBe('expired');
  });

  it('does not burn a link that has expired or is forged (no claim is made)', async () => {
    const { links, store, advance } = setup();
    const { token } = links.issue(VERSION);
    advance(61_000);
    await kind(links.redeem(token));
    await kind(links.redeem('garbage'));
    expect(store.keys.size).toBe(0);
  });

  it('refuses a tampered payload, a tampered signature and a different secret', async () => {
    const { links } = setup();
    const { token } = links.issue(VERSION);
    const [payload = '', signature = ''] = token.split('.');

    // Same signature, but the payload now names another version.
    const forged = Buffer.from(
      JSON.stringify({
        v: 1,
        u: '00000000-0000-4000-8000-000000000000',
        exp: 9_999_999_999,
        jti: jtiOf(token),
      }),
    ).toString('base64url');
    expect(await kind(links.redeem(`${forged}.${signature}`))).toBe('invalid');
    // A flipped signature character.
    const flipped = `${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(await kind(links.redeem(`${payload}.${flipped}`))).toBe('invalid');
    // Signed with another secret, even though the payload is well formed.
    const other = createHmac('sha256', 'another-secret-another-secret-another!')
      .update(payload)
      .digest('base64url');
    expect(await kind(links.redeem(`${payload}.${other}`))).toBe('invalid');
  });

  it('refuses malformed tokens', async () => {
    const { links } = setup();
    for (const bad of ['', 'abc', 'a.b.c', '.', 'a.', '.b']) {
      expect(await kind(links.redeem(bad))).toBe('invalid');
    }
    // A correctly signed payload that is not our shape.
    const payload = Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
    expect(await kind(links.redeem(`${payload}.${sig}`))).toBe('invalid');
  });

  it('fails closed when the secret is unset or too short: it neither issues nor accepts', async () => {
    const { token } = setup().links.issue(VERSION);
    for (const secret of [undefined, '', 'too-short']) {
      // Built directly: setup()'s default parameter would turn `undefined` back into the good secret.
      const links = new SignedLinks(secret, new MemoryStore());
      expect(() => links.issue(VERSION)).toThrow(LinkError);
      expect(await kind(links.redeem(token))).toBe('secret_missing');
    }
  });
});
