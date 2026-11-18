import { SESSION_UNAVAILABLE_MESSAGE } from '@/lib/session-unavailable';
import { SignedLinkDtoSchema, type SignedLinkDto } from '@bos/contracts';

import { ApiError, apiFetch } from '@/lib/api';
import { failureOf, openSignedFile } from '@/lib/api-kernel';
import { routeSession } from '@/lib/bff';
import type { Session } from '@/lib/session';

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

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * `GET /v1/quotations/:id/versions/:vid/document`: a 60-second, single-use signed link to the
 * rendered PDF. The API answers 409 while the file is not clean and 404 when there is none. Every
 * call issues a new link, so this is called once per click and never to "check" a file.
 */
async function issueQuotationDocumentLink(
  session: Session,
  quotationId: string,
  versionId: string,
): Promise<SignedLinkDto> {
  const path = `/v1/quotations/${encodeURIComponent(quotationId)}/versions/${encodeURIComponent(versionId)}/document`;
  const res = await apiFetch(session, path, { method: 'GET' });
  const body = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, `GET ${path} failed with ${res.status}`, body);
  const parsed = SignedLinkDtoSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, `GET ${path} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

/**
 * Download the customer PDF of one quotation version. The API hands out a signed link as a
 * relative `/v1/files/<token>` path and the workspace has no public API address (its CSP is
 * `connect-src 'self'`), so this route asks for the link, fetches the bytes over the internal URL
 * and streams them on. The signed token never reaches the browser, and the API's own safe headers
 * (attachment, nosniff, sandbox CSP, the detected type) pass through unchanged.
 *
 * The page offers the link only for a clean file, but the API is the one that refuses an unclean
 * one: a 409 or 404 here becomes a plain "not available".
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; vid: string }> },
): Promise<Response> {
  const { id, vid } = await params;
  if (!UUID.test(id) || !UUID.test(vid)) return plain('That is not a quotation id.', 400);

  const session = await routeSession();
  if (session instanceof Response) {
    if (session.status === 503) {
      const response = plain(SESSION_UNAVAILABLE_MESSAGE, 503);
      response.headers.set('retry-after', '1');
      return response;
    }
    return plain(
      session.status === 401 ? 'Sign in to download this file.' : 'Staff only.',
      session.status,
    );
  }

  try {
    const link = await issueQuotationDocumentLink(session, id, vid);
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
      f.status === 409 || f.status === 404
        ? 'This PDF is not available to download. It may still be preparing or scanning, or it did not pass the scan.'
        : f.message,
      f.status >= 400 && f.status < 500 ? f.status : 502,
    );
  }
}
