import { createHmac, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { AppConfig, FieldKeyring } from '../config/config';
import { CryptoModule } from './crypto.module';
import { FieldCipher, FieldCipherError, last4 } from './field-cipher';

const key1 = randomBytes(32);
const key2 = randomBytes(32);

function ring(activeKid: string, fingerprintKid: string, keys: Record<string, Buffer>) {
  return new FieldKeyring(activeKid, fingerprintKid, new Map(Object.entries(keys)));
}

const PLAINTEXT = '0123456789012345';

/** Swap one base64url character of envelope part `index` for another valid one. */
function tamper(stored: Buffer, index: number): Buffer {
  const parts = stored.toString('utf8').split(':');
  const part = parts[index] ?? '';
  const pos = Math.floor(part.length / 2);
  const swapped = part[pos] === 'A' ? 'B' : 'A';
  parts[index] = part.slice(0, pos) + swapped + part.slice(pos + 1);
  return Buffer.from(parts.join(':'), 'utf8');
}

/** Everything a caught error could put in a log line. */
function errorText(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FieldCipherError);
    const e = error as Error;
    return [e.message, e.stack ?? '', String(e.cause ?? ''), inspect(e, { depth: 5 })].join('\n');
  }
  throw new Error('expected a throw');
}

describe('FieldCipher', () => {
  const cipher = new FieldCipher(ring('k1', 'k1', { k1: key1 }));

  it('round-trips through bytes shaped v1:<kid>:<iv>:<tag>:<ct> in base64url', () => {
    const stored = cipher.encrypt(PLAINTEXT);
    expect(Buffer.isBuffer(stored)).toBe(true);
    const parts = stored.toString('utf8').split(':');
    expect(parts).toHaveLength(5);
    const [version, kid, iv, tag, ct] = parts as [string, string, string, string, string];
    expect(version).toBe('v1');
    expect(kid).toBe('k1');
    for (const part of [iv, tag, ct]) expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(iv, 'base64url')).toHaveLength(12);
    expect(Buffer.from(tag, 'base64url')).toHaveLength(16);
    expect(stored.toString('utf8')).not.toContain(PLAINTEXT);
    expect(cipher.decrypt(stored)).toBe(PLAINTEXT);
    expect(cipher.decrypt(stored.toString('utf8'))).toBe(PLAINTEXT);
  });

  it('uses a fresh IV per call and handles unicode and the empty string', () => {
    expect(cipher.encrypt(PLAINTEXT).equals(cipher.encrypt(PLAINTEXT))).toBe(false);
    expect(cipher.decrypt(cipher.encrypt('खाता नं १२३'))).toBe('खाता नं १२३');
    expect(cipher.decrypt(cipher.encrypt(''))).toBe('');
  });

  it('binds the optional context (AAD): another context does not open the value', () => {
    const stored = cipher.encrypt(PLAINTEXT, 'vendor_bank_accounts:row-1');
    expect(cipher.decrypt(stored, 'vendor_bank_accounts:row-1')).toBe(PLAINTEXT);
    expect(() => cipher.decrypt(stored, 'vendor_bank_accounts:row-2')).toThrow(FieldCipherError);
    expect(() => cipher.decrypt(stored)).toThrow(FieldCipherError);
  });

  it('seals with the active key and still opens values sealed under an older key', () => {
    const old = cipher.encrypt(PLAINTEXT);
    const rotated = new FieldCipher(ring('k2', 'k1', { k1: key1, k2: key2 }));
    const fresh = rotated.encrypt(PLAINTEXT);
    expect(fresh.toString('utf8').split(':')[1]).toBe('k2');
    expect(rotated.decrypt(old)).toBe(PLAINTEXT);
    expect(rotated.decrypt(fresh)).toBe(PLAINTEXT);
  });

  it.each([
    ['the IV', 2],
    ['the tag', 3],
    ['the ciphertext', 4],
  ])('refuses a value whose %s was tampered with', (_name, index) => {
    expect(() => cipher.decrypt(tamper(cipher.encrypt(PLAINTEXT), index))).toThrow(
      'field-cipher: value failed authentication',
    );
  });

  it('refuses a truncated tag, which Node would otherwise accept', () => {
    const parts = cipher.encrypt(PLAINTEXT).toString('utf8').split(':');
    parts[3] = Buffer.from(parts[3] ?? '', 'base64url')
      .subarray(0, 12)
      .toString('base64url');
    expect(() => cipher.decrypt(parts.join(':'))).toThrow('field-cipher: malformed value');
  });

  it('refuses an unknown key id', () => {
    const other = new FieldCipher(ring('k9', 'k9', { k9: key2 }));
    expect(() => cipher.decrypt(other.encrypt(PLAINTEXT))).toThrow(
      'field-cipher: unknown key id',
    );
  });

  it('refuses a value sealed by a different key under the same id', () => {
    const impostor = new FieldCipher(ring('k1', 'k1', { k1: key2 }));
    expect(() => cipher.decrypt(impostor.encrypt(PLAINTEXT))).toThrow(
      'field-cipher: value failed authentication',
    );
  });

  it.each([
    ['plaintext', PLAINTEXT],
    ['another version', 'v2:k1:AAAA:AAAA:AAAA'],
    ['too few parts', 'v1:k1:AAAA:AAAA'],
    ['too many parts', 'v1:k1:AAAA:AAAA:AAAA:AAAA'],
    ['non-base64url characters', 'v1:k1:AA+A:AAAA:AAAA'],
  ])('refuses a malformed value (%s)', (_name, stored) => {
    expect(() => cipher.decrypt(stored)).toThrow('field-cipher: malformed value');
  });

  it('never puts plaintext or key material in a thrown error', () => {
    const stored = cipher.encrypt(PLAINTEXT);
    const secrets = [
      PLAINTEXT,
      key1.toString('base64'),
      key1.toString('base64url'),
      key1.toString('hex'),
      key2.toString('base64'),
      key2.toString('hex'),
      stored.toString('utf8'),
    ];
    const texts = [
      errorText(() => cipher.decrypt(tamper(stored, 4))),
      errorText(() => cipher.decrypt(tamper(stored, 3))),
      errorText(() => new FieldCipher(ring('k1', 'k1', { k1: key2 })).decrypt(stored)),
      errorText(() => new FieldCipher(ring('k2', 'k2', { k2: key2 })).decrypt(stored)),
      errorText(() => cipher.decrypt(PLAINTEXT)),
      errorText(() => last4('123')),
    ];
    for (const text of texts) for (const secret of secrets) expect(text).not.toContain(secret);
  });

  it('prints no key material when logged', () => {
    const rotated = new FieldCipher(ring('k2', 'k1', { k1: key1, k2: key2 }));
    const texts = [
      JSON.stringify(rotated),
      String(rotated),
      inspect(rotated, { depth: 10, showHidden: true }),
      JSON.stringify({ cipher: rotated }),
    ];
    for (const text of texts) {
      for (const key of [key1, key2]) {
        expect(text).not.toContain(key.toString('base64'));
        expect(text).not.toContain(key.toString('hex'));
      }
    }
  });
});

describe('fingerprint()', () => {
  const cipher = new FieldCipher(ring('k1', 'k1', { k1: key1 }));

  it('is deterministic, tagged with its source key id, and hides the plaintext', () => {
    const fp = cipher.fingerprint(PLAINTEXT);
    expect(fp).toMatch(/^fp1:k1:[A-Za-z0-9_-]{43}$/);
    expect(cipher.fingerprint(PLAINTEXT)).toBe(fp);
    expect(cipher.fingerprint('0123456789012346')).not.toBe(fp);
    expect(fp).not.toContain(PLAINTEXT);
  });

  it('survives rotating the active key, because it follows the fingerprint key id', () => {
    const rotated = new FieldCipher(ring('k2', 'k1', { k1: key1, k2: key2 }));
    expect(rotated.fingerprint(PLAINTEXT)).toBe(cipher.fingerprint(PLAINTEXT));
  });

  it('uses a key derived from, not equal to, the encryption key', () => {
    const naive = createHmac('sha256', key1).update(PLAINTEXT, 'utf8').digest('base64url');
    expect(cipher.fingerprint(PLAINTEXT)).not.toBe(`fp1:k1:${naive}`);
    const otherKey = new FieldCipher(ring('k1', 'k1', { k1: key2 }));
    expect(otherKey.fingerprint(PLAINTEXT)).not.toBe(cipher.fingerprint(PLAINTEXT));
  });
});

describe('last4()', () => {
  it('returns the last four characters, ignoring whitespace', () => {
    expect(last4('0123456789012345')).toBe('2345');
    expect(last4(' 0123 4567 8901 ')).toBe('8901');
    expect(last4('१२३४५६')).toBe('३४५६');
  });

  it('refuses a value of four characters or fewer, which last4 would reveal whole', () => {
    expect(() => last4('1234')).toThrow(FieldCipherError);
    expect(() => last4(' 1 2 ')).toThrow(FieldCipherError);
  });
});

describe('CryptoModule', () => {
  // Stands in for the global ConfigModule, which provides AppConfig to every module.
  @Module({})
  class FakeConfigModule {}

  async function build(keyring: FieldKeyring | undefined) {
    const config = {
      module: FakeConfigModule,
      global: true,
      providers: [{ provide: AppConfig, useValue: { FIELD_ENC_KEYS: keyring } }],
      exports: [AppConfig],
    };
    return Test.createTestingModule({ imports: [config, CryptoModule] }).compile();
  }

  it('provides a FieldCipher built from the configured keyring', async () => {
    const moduleRef = await build(ring('k1', 'k1', { k1: key1 }));
    const cipher = moduleRef.get(FieldCipher);
    expect(cipher.decrypt(cipher.encrypt(PLAINTEXT))).toBe(PLAINTEXT);
  });

  it('fails the boot, naming only the variable, when there is no keyring', async () => {
    await expect(build(undefined)).rejects.toThrow(
      'FIELD_ENC_KEYS is not set: field encryption needs a keyring',
    );
  });
});
