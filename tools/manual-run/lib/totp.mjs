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

/**
 * Parallel lanes sign in as the same persona; a one-time code can be used once per 30 s window, so a second
 * lane typing the same code is refused and times out. Claims the current window for this secret across
 * processes (a marker file per secret under the OS temp dir) and waits for the next window when another
 * lane already used this one. Returns the code to type now.
 */
export async function claimCode(secret) {
  const { createHash } = await import('node:crypto');
  const { mkdirSync, readFileSync, writeFileSync, rmdirSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const base = join(
    tmpdir(),
    `bos-totp-${createHash('sha256').update(secret).digest('hex').slice(0, 16)}`,
  );
  const lock = `${base}.lock`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    try {
      mkdirSync(lock);
    } catch {
      await sleep(200);
      continue;
    }
    try {
      const win = Math.floor(Date.now() / TOTP_STEP_MS);
      const used = existsSync(base) ? Number(readFileSync(base, 'utf8')) : -1;
      if (used < win) {
        writeFileSync(base, String(win));
        return totp(secret);
      }
    } finally {
      rmdirSync(lock);
    }
    await sleep(1000);
  }
}
