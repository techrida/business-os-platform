// RFC 6238 one-time codes (SHA-1, 6 digits, 30 s), as the stack's authenticator accounts use.
import { createHmac } from 'node:crypto';

export const TOTP_STEP_MS = 30_000;

export function totp(secret, now = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/[\s=]/g, '').toUpperCase())
    bits += A.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(now / TOTP_STEP_MS)));
  const h = createHmac('sha1', key).update(ctr).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
