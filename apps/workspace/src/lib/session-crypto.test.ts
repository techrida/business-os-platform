import { describe, expect, it } from 'vitest';

import { type Keyring, openSessionValue, sealSessionValue } from './session-crypto';

const KEY_1 = Buffer.alloc(32, 1);
const KEY_2 = Buffer.alloc(32, 2);
const RING: Keyring = { currentId: 'k1', keys: new Map([['k1', KEY_1]]) };
const AAD = 'ws:sess:' + 'a'.repeat(64);
const PLAINTEXT = JSON.stringify({
  accessToken: 'access-secret-1',
  refreshToken: 'refresh-secret-1',
});

/** Replace one dot-separated part of a stored value. */
function withPart(stored: string, index: number, value: string): string {
  const parts = stored.split('.');
  parts[index] = value;
  return parts.join('.');
}

/** Flip one bit of a base64url part, keeping its length. */
function flip(part: string): string {
  const bytes = Buffer.from(part, 'base64url');
  bytes[0] = (bytes[0] as number) ^ 1;
  return bytes.toString('base64url');
}

describe('sealSessionValue / openSessionValue', () => {
  it('round-trips and stores v1.<keyId>.<iv>.<ciphertext>.<tag> in base64url', () => {
    const stored = sealSessionValue(PLAINTEXT, AAD, RING);
    expect(stored).toMatch(/^v1\.k1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    const [, , iv, , tag] = stored.split('.');
    expect(Buffer.from(iv as string, 'base64url')).toHaveLength(12);
    expect(Buffer.from(tag as string, 'base64url')).toHaveLength(16);
    expect(openSessionValue(stored, AAD, RING)).toBe(PLAINTEXT);
  });

  it('uses a fresh IV for every write', () => {
    const a = sealSessionValue(PLAINTEXT, AAD, RING);
    const b = sealSessionValue(PLAINTEXT, AAD, RING);
    expect(a.split('.')[2]).not.toBe(b.split('.')[2]);
    expect(a).not.toBe(b);
  });

  it('never contains the token text', () => {
    const stored = sealSessionValue(PLAINTEXT, AAD, RING);
    for (const secret of ['access-secret-1', 'refresh-secret-1', 'accessToken']) {
      expect(stored).not.toContain(secret);
      expect(Buffer.from(stored.split('.')[3] as string, 'base64url').toString()).not.toContain(
        secret,
      );
    }
  });

  it('rejects a tampered tag, IV or ciphertext', () => {
    const stored = sealSessionValue(PLAINTEXT, AAD, RING);
    for (const index of [2, 3, 4]) {
      const part = stored.split('.')[index] as string;
      expect(openSessionValue(withPart(stored, index, flip(part)), AAD, RING)).toBeNull();
    }
  });

  it('rejects a truncated tag', () => {
    const stored = sealSessionValue(PLAINTEXT, AAD, RING);
    const tag = Buffer.from(stored.split('.')[4] as string, 'base64url');
    const short = tag.subarray(0, 8).toString('base64url');
    expect(openSessionValue(withPart(stored, 4, short), AAD, RING)).toBeNull();
  });

  it('is bound to its key: a value copied under another key does not open', () => {
    const stored = sealSessionValue(PLAINTEXT, AAD, RING);
    expect(openSessionValue(stored, 'ws:sess:' + 'b'.repeat(64), RING)).toBeNull();
  });

  it('rejects an unknown key id, and a known id whose key differs', () => {
    const stored = sealSessionValue(PLAINTEXT, AAD, RING);
    expect(openSessionValue(withPart(stored, 1, 'k9'), AAD, RING)).toBeNull();
    const rotated: Keyring = { currentId: 'k1', keys: new Map([['k1', KEY_2]]) };
    expect(openSessionValue(stored, AAD, rotated)).toBeNull();
  });

  it('opens values sealed under an older key that is still in the ring', () => {
    const old: Keyring = { currentId: 'k1', keys: new Map([['k1', KEY_1]]) };
    const stored = sealSessionValue(PLAINTEXT, AAD, old);
    const ring: Keyring = {
      currentId: 'k2',
      keys: new Map([
        ['k1', KEY_1],
        ['k2', KEY_2],
      ]),
    };
    expect(openSessionValue(stored, AAD, ring)).toBe(PLAINTEXT);
    expect(sealSessionValue(PLAINTEXT, AAD, ring).split('.')[1]).toBe('k2');
  });

  it.each([
    ['old plaintext JSON', PLAINTEXT],
    ['an empty string', ''],
    ['the wrong version', 'v2.k1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA'],
    ['too few parts', 'v1.k1.AAAAAAAAAAAAAAAA.AAAA'],
    ['too many parts', 'v1.k1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA.x'],
    ['a short IV', 'v1.k1.AAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA'],
  ])('returns null for %s', (_label, stored) => {
    expect(openSessionValue(stored, AAD, RING)).toBeNull();
  });

  it('refuses to seal with a current key id that is not in the ring', () => {
    const broken: Keyring = { currentId: 'k2', keys: new Map([['k1', KEY_1]]) };
    expect(() => sealSessionValue(PLAINTEXT, AAD, broken)).toThrow(/k2/);
  });
});
