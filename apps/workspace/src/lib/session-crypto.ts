import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption at rest for session records (CR-13).
 *
 * Valkey's AOF writes every value to disk, so a record holding access and refresh tokens is
 * sealed with AES-256-GCM before it is stored. The stored value is
 *
 *   v1.<keyId>.<iv>.<ciphertext>.<tag>     (iv, ciphertext and tag in base64url)
 *
 * with a random 12-byte IV per write and a 16-byte tag. The Valkey key the value is stored under
 * is the AAD, so a value copied to another session's key does not open. The key id names the
 * key that sealed the value, so a rotated key can keep opening older values while it is still in
 * the keyring; ids not in the keyring are refused.
 *
 * Pure functions: the caller builds the keyring (session.ts does it from the env on each call).
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface Keyring {
  /** The id new values are sealed with; it must be in `keys`. */
  currentId: string;
  /** Every key that may still open a stored value, by id. */
  keys: ReadonlyMap<string, Buffer>;
}

/** Seals `plaintext` for storage under the Valkey key `aad`. */
export function sealSessionValue(plaintext: string, aad: string, ring: Keyring): string {
  const key = ring.keys.get(ring.currentId);
  if (key?.length !== KEY_BYTES) {
    throw new Error(`session-crypto: no 32-byte key for key id ${ring.currentId}`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    ring.currentId,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

/**
 * Opens a value stored under the Valkey key `aad`. Returns null for anything that does not
 * authenticate: another format (including old plaintext records), an unknown key id, a wrong
 * key, a tampered part or a different key name.
 */
export function openSessionValue(stored: string, aad: string, ring: Keyring): string | null {
  const parts = stored.split('.');
  if (parts.length !== 5) return null;
  const [version, keyId, ivPart, ciphertextPart, tagPart] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== VERSION) return null;
  const key = ring.keys.get(keyId);
  if (key?.length !== KEY_BYTES) return null;

  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  // Node would otherwise accept a truncated tag, which weakens the authentication.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    return null;
  }
}
