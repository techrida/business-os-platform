// Everything the driver reports (console lines, captions, results.json, results.md, summaries)
// passes through redactText:
// - URLs lose their query string and fragment: a sign-in callback carries `?code=…&state=…`, and
//   nothing the driver reports needs either part;
// - a user name and password inside a URL (`https://user:pw@host`) become `[redacted]@`;
// - every registered secret (persona passwords, TOTP secrets, one-time codes) becomes `[redacted]`.
//   Playwright puts the typed value into the message of a failed fill/pressSequentially and into its
//   call log, so a failed input action could otherwise copy a password into the results.
import { TOTP_STEP_MS, totp } from './totp.mjs';

export const REDACTED = '[redacted]';
const REDACTED_URL = '[redacted-url]';

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

// Every `scheme://…` in a text is read with the WHATWG URL parser, which is the only reliable way to
// tell the user info from a later `@` in a query (`?login_hint=a@b.c&code=…`): a URL that parses
// keeps only `scheme://[redacted]@host/path` (no query, no fragment); one that does not parse (a
// password with a raw `?` or `#`) is replaced as a whole. A protocol-relative `//user:pw@host/x`
// has no scheme to parse, so its user info is cut at the authority's end.
const URL_CANDIDATE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi;
const TRAILING = /[)\]}>.,;:!'"]+$/;
const PROTOCOL_RELATIVE_USERINFO = /(?<![\w:/])\/\/[^\s/?#@]*@/g;

function readUrl(candidate) {
  const trailing = TRAILING.exec(candidate)?.[0] ?? '';
  const raw = trailing ? candidate.slice(0, -trailing.length) : candidate;
  let out;
  try {
    const u = new URL(raw);
    const hasPath = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*\//i.test(raw);
    const path = u.pathname === '/' && !hasPath ? '' : u.pathname;
    out = `${u.protocol}//${u.username || u.password ? `${REDACTED}@` : ''}${u.host}${path}`;
  } catch {
    out = REDACTED_URL;
  }
  return out + trailing;
}

const stripUserinfo = (text) =>
  text.replace(URL_CANDIDATE, readUrl).replace(PROTOCOL_RELATIVE_USERINFO, `//${REDACTED}@`);

/** `https://u:pw@h/p?code=1#x` → `https://[redacted]@h/p`. Non-URL text is returned unchanged. */
export function redactUrl(url) {
  const text = String(url ?? '');
  // A relative URL (`/payments/x?q=a`) has no scheme: drop its query and fragment.
  const clean = redactSecrets(text); // before parsing: the parser re-encodes a secret in a path
  return redactSecrets(
    /^[a-z][a-z0-9+.-]*:\/\//i.test(clean) ? stripUserinfo(clean) : clean.replace(/[?#].*$/s, ''),
  );
}

/**
 * Strips the user info, query and fragment of every URL inside free text, and every secret.
 */
export function redactText(text) {
  return redactSecrets(stripUserinfo(redactSecrets(String(text ?? ''))));
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
