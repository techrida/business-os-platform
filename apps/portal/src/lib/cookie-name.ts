export function portalCookieName(kind: 'session' | 'login' | 'signed_out' | 'signed_in'): string {
  return `${process.env.BOS_PORTAL_COOKIE_PREFIX ?? '__Host-bos_portal'}_${kind}`;
}
