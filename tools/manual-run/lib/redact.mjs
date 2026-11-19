// Everything the driver reports (console lines, captions, results.json, results.md, summaries)
// passes through redactText:
// - URLs lose their query string and fragment: a sign-in callback carries `?code=…&state=…`, and
//   nothing the driver reports needs either part;
// - every registered secret (persona passwords, TOTP secrets, one-time codes) becomes `[redacted]`.
//   Playwright puts the typed value into the message of a failed fill/pressSequentially and into its
//   call log, so a failed input action could otherwise copy a password into the results.
import { TOTP_STEP_MS, totp } from './totp.mjs';

export const REDACTED = '[redacted]';

const secrets = new Set();
const totpSecrets = new Set();
const codes = new Set();

/** The text forms a value can take in a message: as typed, and escaped inside a JSON string. */
function forms(value) {
  const s = String(value);
  return [s, JSON.stringify(s).slice(1, -1)];
}

/** A password or other secret string; never printed, replaced wherever it appears. */
export function registerSecret(value) {
  if (typeof value !== 'string' || value === '') return;
  for (const f of forms(value)) secrets.add(f);
}

/**
 * A TOTP secret: the secret itself, and its codes of the windows around the moment of redaction
 * (current, two before, two after), are replaced. Codes computed at sign-in are registered too.
 */
export function registerTotpSecret(secret) {
  if (typeof secret !== 'string' || secret === '') return;
  registerSecret(secret);
  totpSecrets.add(secret);
}

/** A one-time code that was computed (and typed): it stays redacted after its window passes. */
export function registerCode(code) {
  if (/^\d{4,10}$/.test(String(code))) codes.add(String(code));
}

/** For self-tests: forget every registered secret. */
export function clearSecrets() {
  secrets.clear();
  totpSecrets.clear();
  codes.clear();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces every registered secret and every current one-time code in `text`. */
export function redactSecrets(text) {
  let out = String(text ?? '');
  if (!secrets.size && !codes.size && !totpSecrets.size) return out;
  // Longest first, so a secret that contains another is replaced whole.
  for (const s of [...secrets].sort((a, b) => b.length - a.length))
    out = out.split(s).join(REDACTED);
  const live = new Set(codes);
  const now = Date.now();
  for (const secret of totpSecrets)
    for (let w = -2; w <= 2; w++) {
      try {
        live.add(totp(secret, now + w * TOTP_STEP_MS));
      } catch {
        // not a base32 secret: the secret itself is still replaced above
      }
    }
  // A code only where it stands alone as a number (not inside a longer run of digits).
  for (const c of live)
    out = out.replace(new RegExp(`(?<!\\d)${escapeRe(c)}(?!\\d)`, 'g'), REDACTED);
  return out;
}

/** `https://h/p?code=1#x` → `https://h/p`. Non-URL text is returned unchanged. */
export function redactUrl(url) {
  return redactSecrets(String(url ?? '').replace(/[?#].*$/s, ''));
}

/** Strips the query and fragment of every http(s) URL inside free text, and every secret. */
export function redactText(text) {
  return redactSecrets(
    String(text ?? '').replace(/\b(https?:\/\/[^\s?#'"<>]*)[?#][^\s'"<>]*/g, '$1'),
  );
}

/**
 * A copy of `value` with every string inside it (object values and array items, at any depth)
 * passed through redactText. Numbers stay numbers: a duration that happens to equal a code is
 * not touched, and the JSON stays valid.
 */
export function redactDeep(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  return value;
}
