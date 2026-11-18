import { ApiError } from '@/lib/api';
import { getVendorPurchaseOrderLink, openVendorFile } from '@/lib/api.vendor';
import { SessionUnavailableError, SESSION_UNAVAILABLE_MESSAGE } from '@/lib/session-unavailable';
import { getSession, type Session } from '@/lib/session';

import { isUuid } from '../../../load';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NOT_FOUND = 'Purchase order not found.';

/** A download is a page navigation, so a failure is plain text a person can read, not JSON. */
function plain(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Download the issued PDF of one purchase order. Route handlers run no layout, so this checks the
 * session itself. The API hands out a short-lived signed link as a relative `/v1/files/<token>`
 * path, and the portal has no public API address (CSP `connect-src 'self'`), so this route fetches
 * the bytes over the internal URL and streams them on. The token never reaches the browser, and
 * only the API's safe headers (type, attachment, length, sandbox CSP) are passed through.
 *
 * A bad id, a 404 and a 403 all answer the same "Purchase order not found": the vendor must not
 * learn whether an order that is not theirs, or not yet issued, exists.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let session: Session | null;
  try {
    session = await getSession();
  } catch (err) {
    if (!(err instanceof SessionUnavailableError)) throw err;
    const response = plain(SESSION_UNAVAILABLE_MESSAGE, 503);
    response.headers.set('retry-after', '1');
    return response;
  }
  if (!session) return plain('Sign in to download this purchase order.', 401);
  // No layout runs here, so a customer session is turned away with the same answer as a foreign id.
  if (session.orgKind !== 'vendor') return plain(NOT_FOUND, 404);

  const { id } = await params;
  if (!isUuid(id)) return plain(NOT_FOUND, 404);

  try {
    const link = await getVendorPurchaseOrderLink(session, id);
    const file = await openVendorFile(session, link);
    const headers = new Headers({
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    for (const name of [
      'content-type',
      'content-disposition',
      'content-length',
      'content-security-policy',
    ]) {
      const value = file.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    return new Response(file.body, { status: 200, headers });
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 0;
    if (status === 404 || status === 403) return plain(NOT_FOUND, 404);
    if (status === 401) return plain('Sign in to download this purchase order.', 401);
    if (status === 409 || status === 410) {
      return plain(
        'This PDF is not available to download yet. Please try again in a few minutes.',
        409,
      );
    }
    return plain('We could not fetch the PDF just now. Please try again.', 502);
  }
}
