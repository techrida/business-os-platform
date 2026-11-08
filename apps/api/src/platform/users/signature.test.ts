import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyZitadelSignature } from './signature';

const KEY = 'test-signing-key-from-create-target';
const BODY = Buffer.from(
  JSON.stringify({ aggregateID: '312', aggregateType: 'user', sequence: 7, instanceID: 'i1' }),
);
const NOW = 1_762_600_000;

/** The reference computation, written independently of the code under test. */
function sign(t: number, body: Buffer, key = KEY): string {
  return createHmac('sha256', key).update(`${t}.`).update(body).digest('hex');
}

describe('verifyZitadelSignature', () => {
  it('accepts a known vector', () => {
    expect(verifyZitadelSignature(BODY, `t=${NOW},v1=${sign(NOW, BODY)}`, KEY, NOW)).toBe(true);
  });

  it('rejects a signature made with the wrong key', () => {
    const header = `t=${NOW},v1=${sign(NOW, BODY, 'another-key')}`;
    expect(verifyZitadelSignature(BODY, header, KEY, NOW)).toBe(false);
  });

  it('rejects a changed body', () => {
    const header = `t=${NOW},v1=${sign(NOW, BODY)}`;
    expect(verifyZitadelSignature(Buffer.from(`${BODY.toString()} `), header, KEY, NOW)).toBe(
      false,
    );
  });

  it('rejects a stale or future t, and accepts the edge of the tolerance', () => {
    const old = NOW - 301;
    expect(verifyZitadelSignature(BODY, `t=${old},v1=${sign(old, BODY)}`, KEY, NOW)).toBe(false);
    const future = NOW + 301;
    expect(verifyZitadelSignature(BODY, `t=${future},v1=${sign(future, BODY)}`, KEY, NOW)).toBe(
      false,
    );
    const edge = NOW - 300;
    expect(verifyZitadelSignature(BODY, `t=${edge},v1=${sign(edge, BODY)}`, KEY, NOW)).toBe(true);
  });

  it('accepts any matching v1 among several (key rotation)', () => {
    const wrong = sign(NOW, BODY, 'old-key');
    expect(
      verifyZitadelSignature(BODY, `t=${NOW},v1=${wrong},v1=${sign(NOW, BODY)}`, KEY, NOW),
    ).toBe(true);
    expect(
      verifyZitadelSignature(BODY, `t=${NOW},v1=${wrong},v1=${sign(NOW, BODY, 'x')}`, KEY, NOW),
    ).toBe(false);
  });

  it('rejects malformed headers without throwing', () => {
    const good = sign(NOW, BODY);
    for (const header of [
      '',
      `v1=${good}`,
      `t=${NOW}`,
      `t=abc,v1=${good}`,
      `t=1e9,v1=${good}`,
      `t=${NOW},v1=${good.slice(0, 63)}`,
      `t=${NOW},v1=${good}zz`,
      `t=${NOW},v1=`,
    ]) {
      expect(verifyZitadelSignature(BODY, header, KEY, NOW)).toBe(false);
    }
    expect(verifyZitadelSignature(BODY, `t=${NOW},v1=${good}`, '', NOW)).toBe(false);
  });
});
