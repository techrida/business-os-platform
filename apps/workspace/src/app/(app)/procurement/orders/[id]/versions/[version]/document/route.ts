import { SESSION_UNAVAILABLE_MESSAGE } from '@/lib/session-unavailable';
import { issuePoDocumentLink } from '@/lib/api-purchase-orders';
import { failureOf, openSignedFile } from '@/lib/api-kernel';
import { routeSession } from '@/lib/bff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A version number: a positive whole number (the API parses it as an integer). */
const VERSION = /^[1-9]\d{0,8}$/;

/** A download is a page navigation, so a failure is plain text a person can read, not JSON. */
function plain(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Download the PDF of one issued purchase order version. The API hands out a signed link as a
 * relative `/v1/files/<token>` path and the workspace has no public API address (its CSP is
 * `connect-src 'self'`), so this route asks for the link, fetches the bytes over the internal URL
 * and streams them on. The signed token never reaches the browser, and the API's own safe headers
 * (attachment, nosniff, sandbox CSP, the detected type) pass through unchanged.
 *
 * The API answers 404 while the file is not rendered and scanned clean; that becomes a plain
 * "not available". Every call issues a new link, so this runs once per click.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; version: string }> },
): Promise<Response> {
  const { id, version } = await params;
  if (!UUID.test(id)) return plain('That is not a purchase order id.', 400);
  if (!VERSION.test(version)) return plain('That is not a version number.', 400);

  const session = await routeSession();
  if (session instanceof Response) {
    if (session.status === 503) {
      const response = plain(SESSION_UNAVAILABLE_MESSAGE, 503);
      response.headers.set('retry-after', session.headers.get('retry-after') ?? '1');
      return response;
    }
    return plain(
      session.status === 401 ? 'Sign in to download this file.' : 'Staff only.',
      session.status,
    );
  }

  try {
    const link = await issuePoDocumentLink(session, id, Number(version));
    const file = await openSignedFile(session, link);
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
    const f = failureOf(err);
    return plain(
      f.status === 404 || f.status === 409
        ? 'This PDF is not available to download. It may still be preparing or scanning, or it did not pass the scan.'
        : f.message,
      f.status >= 400 && f.status < 500 ? f.status : 502,
    );
  }
}
