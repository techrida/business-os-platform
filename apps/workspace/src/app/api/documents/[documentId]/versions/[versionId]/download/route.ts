import { failureOf, issueDocumentLink, openSignedFile } from '@/lib/api-kernel';
import { dbBusyOf, routeSession } from '@/lib/bff';
import { SESSION_UNAVAILABLE_MESSAGE } from '@/lib/session-unavailable';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A download is a page navigation, so a failure is plain text a person can read, not JSON. */
function plain(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Download one attachment. The API hands out a 60-second signed link as a relative `/v1/files/<token>`
 * path, and the workspace has no public API address (its CSP is `connect-src 'self'`). So this
 * route asks for the link, fetches the bytes over the internal URL and streams them on. The
 * signed token never reaches the browser, and the API's own safe headers (attachment, nosniff,
 * sandbox CSP, the type the server detected) are passed through unchanged.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ documentId: string; versionId: string }> },
): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) {
    if (session.status === 503) {
      // The session store did not answer: not a sign-out and not a refusal. Say so, and let the browser retry.
      const res = plain(SESSION_UNAVAILABLE_MESSAGE, 503);
      res.headers.set('retry-after', session.headers.get('retry-after') ?? '1');
      return res;
    }
    return plain(
      session.status === 401 ? 'Sign in to download this file.' : 'Staff only.',
      session.status,
    );
  }
  const { documentId, versionId } = await params;
  if (!UUID.test(documentId) || !UUID.test(versionId)) return plain('That is not a file id.', 400);

  try {
    const link = await issueDocumentLink(session, documentId, versionId);
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
    const busy = dbBusyOf(err);
    if (busy !== null) {
      const res = plain('Busy, please try again.', 503);
      res.headers.set('retry-after', String(busy.retryAfterSeconds));
      return res;
    }
    const f = failureOf(err);
    // A file that is not clean yet answers 409 or 404; say that in words.
    return plain(
      f.status === 409 || f.status === 404
        ? 'This file is not available to download. It may still be scanning, or it did not pass the scan.'
        : f.message,
      f.status >= 400 && f.status < 500 ? f.status : 502,
    );
  }
}
