import 'server-only';

import { ApiError } from '@/lib/api';
import { getSession, type Session } from '@/lib/session';
import { SessionUnavailableError, SESSION_UNAVAILABLE_MESSAGE } from '@/lib/session-unavailable';

/** The shape of a short-lived signed link the API hands out (`/v1/files/<token>`). */
export interface SignedLink {
  url: string;
  expiresAt: string;
}

export interface SignedFileRouteOptions {
  /** `download` streams the API's attachment as is; `preview` is the inline variant for the viewer. */
  mode: 'download' | 'preview';
  /** The org kind this route serves. Anyone else gets the same "not found" as a foreign id. */
  orgKind: Session['orgKind'];
  /** Shown for a bad id, a 403 and a 404, so the caller learns nothing about what exists. */
  notFound: string;
  /** What a signed-out visitor is asked to do, e.g. "Sign in to download this invoice.". */
  signIn: string;
  isId: (id: string) => boolean;
  params: Promise<{ id: string }>;
  /** Asks the API for the signed link: exactly one call per request. */
  getLink: (session: Session, id: string) => Promise<SignedLink>;
  /** Fetches the bytes behind the link (the API's `openSignedFile`, or the vendor alias). */
  openFile: (session: Session, link: SignedLink) => Promise<Response>;
}

/** A file route is a page navigation, so a failure is plain text a person can read, not JSON. */
function plain(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** The download headers the API sets that are safe to pass on. */
const DOWNLOAD_HEADERS = [
  'content-type',
  'content-disposition',
  'content-length',
  'content-security-policy',
] as const;

/** `attachment; filename="x.pdf"` becomes `inline; filename="x.pdf"`; a missing header is plain `inline`. */
function toInline(disposition: string | null): string {
  if (disposition === null) return 'inline';
  const rest = /^\s*[A-Za-z]+(.*)$/s.exec(disposition)?.[1] ?? '';
  return `inline${rest}`;
}

/** What a customer reads when their PDF failed to render or was refused by the scan. */
export const DELAYED_MESSAGE = 'This PDF is delayed. Our team has been told.';

/** What a person reads when the short-lived download link ran out before the file was fetched. */
export const LINK_EXPIRED_MESSAGE =
  'This download link has expired. Go back to the page and open the document again.';

const isPdf = (contentType: string | null): boolean =>
  (contentType ?? '').split(';')[0]?.trim().toLowerCase() === 'application/pdf';

/**
 * The one handler behind every portal PDF route and its preview sibling. Route handlers run no
 * layout, so this checks the session itself; order is session, org kind, id, then the API.
 *
 * Download passes the API's safe headers through, including its sandbox CSP. Preview is for an
 * the app's own document viewer: only a PDF is served, inline, with no CSP or sandbox
 * header (a sandbox stops the browser's PDF viewer) and nothing that could set a cookie.
 *
 * A bad id, a 404 and a 403 all answer the same `notFound` text, and 409 and 410 both mean the PDF
 * is not ready. On a customer route the API's 424 (the PDF failed or was refused) answers 424 with
 * `DELAYED_MESSAGE`; vendor routes keep their old answer. The token and the API address never
 * reach the browser.
 */
export async function handleSignedFile(opts: SignedFileRouteOptions): Promise<Response> {
  let session: Session | null;
  try {
    session = await getSession();
  } catch (err) {
    if (!(err instanceof SessionUnavailableError)) throw err;
    const response = plain(SESSION_UNAVAILABLE_MESSAGE, 503);
    response.headers.set('retry-after', '1');
    return response;
  }
  if (!session) return plain(opts.signIn, 401);
  // No layout runs here, so the other org kind is turned away with the same answer as a foreign id.
  if (session.orgKind !== opts.orgKind) return plain(opts.notFound, 404);

  const { id } = await opts.params;
  if (!opts.isId(id)) return plain(opts.notFound, 404);

  // Which call failed matters: a 401 or 410 from the file itself means the signed link ran out, not that the
  // person is signed out, and a missing file is a plain not-found page, never a gateway error (R6D).
  let stage: 'link' | 'file' = 'link';
  try {
    const link = await opts.getLink(session, id);
    stage = 'file';
    const file = await opts.openFile(session, link);
    const headers = new Headers({
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    if (opts.mode === 'preview') {
      if (!isPdf(file.headers.get('content-type'))) {
        await file.body?.cancel();
        return plain('This document cannot be previewed.', 415);
      }
      headers.set('content-type', 'application/pdf');
      headers.set('content-disposition', toInline(file.headers.get('content-disposition')));
      const length = file.headers.get('content-length');
      if (length !== null) headers.set('content-length', length);
    } else {
      for (const name of DOWNLOAD_HEADERS) {
        const value = file.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
    }
    return new Response(file.body, { status: 200, headers });
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 0;
    if (status === 404 || status === 403) return plain(opts.notFound, 404);
    if (stage === 'file' && (status === 401 || status === 410))
      return plain(LINK_EXPIRED_MESSAGE, 410);
    if (status === 401) return plain(opts.signIn, 401);
    if (status === 503) {
      const response = plain('This is busy right now. Please try again in a moment.', 503);
      response.headers.set('retry-after', '1');
      return response;
    }
    if (status === 409 || status === 410) {
      return plain(
        'This PDF is not available to download yet. Please try again in a few minutes.',
        409,
      );
    }
    // Only the customer document routes have the failed-PDF state; vendor PO routes are unchanged.
    if (status === 424 && opts.orgKind === 'customer') return plain(DELAYED_MESSAGE, 424);
    return plain('We could not fetch the PDF just now. Please try again.', 502);
  }
}
