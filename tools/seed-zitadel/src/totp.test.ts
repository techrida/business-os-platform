import { describe, expect, it } from 'vitest';

import { totpCode } from './totp.js';

// RFC 6238 appendix B: the SHA-1 secret is the ASCII string "12345678901234567890". The RFC lists
// 8-digit codes; at T=59 s it is 94287082, so the 6-digit code is its last six digits.
// The base32 form is computed by hand (not by otplib), so the test does not trust the library twice.
const RFC_SECRET_BASE32 = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

function base32Encode(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

describe('totpCode', () => {
  it('encodes the RFC 6238 secret as the well-known base32 string', () => {
    expect(RFC_SECRET_BASE32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('matches the RFC 6238 SHA-1 vector at T=59 (94287082 -> 287082)', () => {
    expect(totpCode(RFC_SECRET_BASE32, new Date(59_000))).toBe('287082');
  });

  it('matches further RFC 6238 vectors (6-digit tails)', () => {
    expect(totpCode(RFC_SECRET_BASE32, new Date(1_111_111_109_000))).toBe('081804'); // 07081804
    expect(totpCode(RFC_SECRET_BASE32, new Date(1_234_567_890_000))).toBe('005924'); // 89005924
    expect(totpCode(RFC_SECRET_BASE32, new Date(20_000_000_000_000))).toBe('353130'); // 65353130
  });

  it('gives the same code anywhere inside one 30 s step and a new one in the next', () => {
    const start = totpCode(RFC_SECRET_BASE32, new Date(30_000));
    expect(totpCode(RFC_SECRET_BASE32, new Date(59_999))).toBe(start);
    expect(totpCode(RFC_SECRET_BASE32, new Date(60_000))).not.toBe(start);
  });

  it('defaults to the current time', () => {
    expect(totpCode(RFC_SECRET_BASE32)).toMatch(/^\d{6}$/);
  });
});
