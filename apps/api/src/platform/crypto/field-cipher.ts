import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import type { FieldKeyring } from '../config/config';

/**
 * Field-level encryption at rest (M20), for values such as vendor bank account numbers (AD9).
 *
 * A sealed value is the UTF-8 bytes of
 *
 *   v1:<kid>:<iv>:<tag>:<ct>     (iv, tag and ct in base64url)
 *
 * stored in a bytea column. AES-256-GCM, a random 12-byte IV per call and a 16-byte tag. The kid names
 * the key that sealed the value, so after a rotation older values still open while their key stays in
 * the keyring. An optional context string is the AAD: pass something like `<table>:<row id>` so a
 * value copied into another row does not open.
 *
 * `fingerprint()` lets equal plaintexts be matched without decrypting (duplicate account checks). Its
 * HMAC-SHA256 key is derived with HKDF from the keyring's fingerprint key, never the raw AES key, and
 * the output carries the source kid (`fp1:<kid>:<mac>`), so fingerprints from different keys never
 * look like a mere "no match".
 *
 * Errors carry fixed messages only: never the plaintext, the stored value, a key or Node's own error.
 */

const VERSION = 'v1';
const FINGERPRINT_VERSION = 'fp1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const FINGERPRINT_INFO = 'bos/field-cipher/fingerprint/v1';
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** A field-cipher failure. The message is one of a fixed set and never holds a value or key. */
export class FieldCipherError extends Error {
  constructor(message: string) {
    super(`field-cipher: ${message}`);
    this.name = 'FieldCipherError';
  }
}

export class FieldCipher {
  readonly #ring: FieldKeyring;
  readonly #fingerprintKey: Buffer;

  constructor(ring: FieldKeyring) {
    for (const kid of ring.kids) {
      if (ring.key(kid)?.length !== KEY_BYTES) {
        throw new FieldCipherError('every key in the keyring must be 32 bytes');
      }
    }
    this.#ring = ring;
    const source = ring.key(ring.fingerprintKid);
    if (source === undefined)
      throw new FieldCipherError('the fingerprint key id is not in the keyring');
    this.#fingerprintKey = Buffer.from(
      hkdfSync('sha256', source, Buffer.alloc(0), FINGERPRINT_INFO, KEY_BYTES),
    );
    Object.freeze(this);
  }

  /** Seal `plaintext` with the active key. `context`, when given, must be passed again to decrypt. */
  encrypt(plaintext: string, context = ''): Buffer {
    const kid = this.#ring.activeKid;
    const key = this.#ring.key(kid);
    if (key === undefined) throw new FieldCipherError('the active key id is not in the keyring');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope = [
      VERSION,
      kid,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ct.toString('base64url'),
    ].join(':');
    return Buffer.from(envelope, 'utf8');
  }

  /**
   * Open a sealed value (the bytea, or its text). Throws a FieldCipherError for a malformed value, an
   * unknown key id, or anything that fails authentication (a tampered part, a wrong key, another context).
   */
  decrypt(stored: Buffer | string, context = ''): string {
    const parts = (typeof stored === 'string' ? stored : stored.toString('utf8')).split(':');
    if (parts.length !== 5) throw new FieldCipherError('malformed value');
    const [version, kid, ivPart, tagPart, ctPart] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (version !== VERSION || ![ivPart, tagPart, ctPart].every((p) => BASE64URL.test(p))) {
      throw new FieldCipherError('malformed value');
    }
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    // Node would otherwise accept a truncated tag, which weakens the authentication.
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new FieldCipherError('malformed value');
    }
    const key = this.#ring.key(kid);
    if (key === undefined) throw new FieldCipherError('unknown key id');

    let plaintext: string;
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(ctPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Node's error is dropped on purpose (no `cause`): only the fixed message may reach a log.
      throw new FieldCipherError('value failed authentication');
    }
    return plaintext;
  }

  /**
   * A deterministic HMAC-SHA256 of `plaintext`, as `fp1:<kid>:<base64url mac>`. Equal inputs give equal
   * fingerprints while the fingerprint key id stays the same. The caller normalises first (for example,
   * strips spaces from an account number), since this hashes the exact string.
   */
  fingerprint(plaintext: string): string {
    const mac = createHmac('sha256', this.#fingerprintKey)
      .update(plaintext, 'utf8')
      .digest('base64url');
    return `${FINGERPRINT_VERSION}:${this.#ring.fingerprintKid}:${mac}`;
  }

  toJSON(): { keyring: FieldKeyring } {
    return { keyring: this.#ring };
  }

  toString(): string {
    return `FieldCipher(${String(this.#ring)})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/**
 * The last four characters of `value`, whitespace ignored, for DTOs that may show only that much.
 * Refuses a value of four characters or fewer, where the "last four" would be the whole value.
 */
export function last4(value: string): string {
  const chars = Array.from(value.replace(/\s+/g, ''));
  if (chars.length <= 4) throw new FieldCipherError('value too short to mask');
  return chars.slice(-4).join('');
}
