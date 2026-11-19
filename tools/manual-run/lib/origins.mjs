// The browser and the driver only talk to the configured origins (APP_URL, PORTAL_URL, MAIL_URL,
// AUTH_URL). These checks run at run time, on every navigation and request, so a misconfigured
// redirect cannot carry the seeded credentials (or anything else) to another site, also with
// network isolation off (NETNS=0).

/** Every configured origin, normalised (`https://host[:port]`). */
export function configuredOrigins(cfg) {
  return [cfg.appUrl, cfg.portalUrl, cfg.mailUrl, cfg.authUrl];
}

// Content that never leaves the browser.
const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'about:']);

/** The origin of an http(s) or ws(s) URL in its https/http form; null for anything else. */
export function originOf(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  const scheme = { 'https:': 'https:', 'wss:': 'https:', 'http:': 'http:', 'ws:': 'http:' }[
    u.protocol
  ];
  if (!scheme || u.username || u.password) return null;
  return new URL(`${scheme}//${u.host}`).origin;
}

/** May the browser load `url`? Only the configured origins and browser-local content. */
export function originAllowed(url, allowed) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  if (LOCAL_SCHEMES.has(u.protocol)) return true;
  const origin = originOf(url);
  return origin !== null && allowed.includes(origin);
}

export class OriginError extends Error {}

/**
 * Throws unless `url` is on one of `allowed` (exact origin: scheme, host and port). `what` names
 * the action in the message. The URL in the message carries no query or fragment.
 */
export function requireOrigin(url, allowed, what) {
  const origin = originOf(url);
  if (origin === null || !allowed.includes(origin))
    throw new OriginError(
      `${what}: ${String(url).replace(/[?#].*$/s, '')} is not on ${allowed.join(' or ')}; refusing.`,
    );
  return origin;
}
