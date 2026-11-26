/**
 * Decides whether a link goes through the client router or stays a plain anchor.
 *
 * A route handler (a login redirect, a PDF, a CSV export) must never be fetched by the router: the
 * router would request it twice, once as a flight request and once as a document, and a prefetch of
 * `/auth/login` would start a login. Everything else inside the app is a page the router can open
 * without a document load.
 */

/** Last path segments that are route handlers in both apps. */
const HANDLER_SEGMENT = /^(export|template|errors|document.*|pdf|file|proofs|evidence|download)$/;

export type LinkKind = 'router' | 'native';

export interface LinkKindInput {
  href: string;
  download?: unknown;
  target?: string | undefined;
  /** Forces the plain anchor. */
  native?: boolean | undefined;
}

export function linkKind({ href, download, target, native }: LinkKindInput): LinkKind {
  if (native === true) return 'native';
  if (download !== undefined && download !== false) return 'native';
  if (target !== undefined && target !== '' && target !== '_self') return 'native';
  // Only a same-site absolute path can use the router. "//host" is protocol-relative, so external.
  if (!href.startsWith('/') || href.startsWith('//')) return 'native';
  const path = href.split(/[?#]/, 1)[0] ?? '';
  const segments = path.split('/').filter(Boolean);
  const first = segments[0];
  if (first === 'auth' || first === 'api') return 'native';
  const last = segments[segments.length - 1];
  if (last !== undefined && HANDLER_SEGMENT.test(last)) return 'native';
  // A handler segment anywhere after the first, e.g. /quotations/1/versions/2/document/preview.
  if (segments.slice(1).some((s) => s.includes('document'))) return 'native';
  return 'router';
}
