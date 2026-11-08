// Verifies the `ZITADEL-Signature` header that ZITADEL Actions v2 puts on every webhook call.
// Serves the NFR "no unauthenticated write path": POST /v1/hooks/zitadel is @Public, so this HMAC
// check is the only thing standing between the internet and a users.sync job.
//
// Format (P1-PLAN §3, from ZITADEL's pkg/actions/signing.go): `t=<unix seconds>,v1=<hex>[,v1=<hex>…]`,
// where v1 = hex(HMAC-SHA256(key = signing key as UTF-8, message = "<t>." + rawBody)). Several v1
// parts appear while a key is being rotated, so any one matching is enough.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** ZITADEL's own default tolerance: a replayed request older (or newer) than this is refused. */
export const SIGNATURE_TOLERANCE_SEC = 300;

const SHA256_BYTES = 32;

/**
 * True only when the header is well formed, `t` is within `toleranceSec` of `nowSec`, and at least
 * one `v1` equals the HMAC of `"<t>." + rawBody`. Never throws: every malformed input is just `false`.
 */
export function verifyZitadelSignature(
  rawBody: Buffer,
  header: string,
  key: string,
  nowSec: number,
  toleranceSec = SIGNATURE_TOLERANCE_SEC,
): boolean {
  if (key.length === 0 || header.length === 0) return false;

  let timestamp: string | undefined;
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === 't') timestamp = value;
    else if (name === 'v1') candidates.push(value);
  }

  // Digits only: Number('1e3') or Number(' 12') would otherwise sneak through as a timestamp.
  if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSec - Number(timestamp)) > toleranceSec) return false;
  if (candidates.length === 0) return false;

  const expected = createHmac('sha256', Buffer.from(key, 'utf8'))
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]))
    .digest();

  let matched = false;
  for (const candidate of candidates) {
    // Buffer.from(hex) silently stops at the first bad character, so check the shape first;
    // timingSafeEqual throws on buffers of different length.
    if (!/^[0-9a-fA-F]{64}$/.test(candidate)) continue;
    const given = Buffer.from(candidate, 'hex');
    if (given.length !== SHA256_BYTES) continue;
    // No early return: every candidate costs the same, whichever one matches.
    if (timingSafeEqual(given, expected)) matched = true;
  }
  return matched;
}
