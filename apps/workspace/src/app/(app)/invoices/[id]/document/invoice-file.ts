import { SESSION_UNAVAILABLE_MESSAGE } from '@/lib/session-unavailable';
import { SignedLinkDtoSchema, type SignedLinkDto } from '@bos/contracts';

import { ApiError, apiFetch } from '@/lib/api';
import { invoiceDocumentPath } from '@/lib/api-billing';
import { failureOf, openSignedFile } from '@/lib/api-kernel';
import { routeSession } from '@/lib/bff';
import type { Session } from '@/lib/session';

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
 * `GET /v1/invoices/:id/document`: a 60-second, single-use signed link to the rendered PDF of an
 * issued invoice. The API answers 409 while the file is not clean and 404 when there is none. Every
 * call issues a new link, so this is called once per click and never to "check" a file.
 */
async function issueInvoiceDocumentLink(session: Session, id: string): Promise<SignedLinkDto> {
  const path = invoiceDocumentPath(id);
  const res = await apiFetch(session, path, { method: 'GET' });
  const body = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, `GET ${path} failed with ${res.status}`, body);
  const parsed = SignedLinkDtoSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, `GET ${path} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

/** Both endpoints read the same clean issued original under invoice.read. */
export async function invoiceFileResponse(
  id: string,
  mode: 'download' | 'preview',
): Promise<Response> {
  if (!UUID.test(id)) return plain('That is not an invoice id.', 400);

  const session = await routeSession();
  if (session instanceof Response) {
    if (session.status === 503) {
      const response = plain(SESSION_UNAVAILABLE_MESSAGE, 503);
      response.headers.set('retry-after', session.headers.get('retry-after') ?? '1');
      return response;
    }
    return plain(
      session.status === 401 ? `Sign in to ${mode} this file.` : 'Staff only.',
      session.status,
    );
  }

  try {
    const link = await issueInvoiceDocumentLink(session, id);
    const file = await openSignedFile(session, link);
    const contentType = file.headers.get('content-type');
    if (mode === 'preview' && (contentType !== 'application/pdf' || !file.body)) {
      await file.body?.cancel();
      return plain('This file cannot be previewed.', 415);
    }
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
    if (mode === 'preview') {
      // The browser can only frame this endpoint from the same origin (see next.config.ts).
      // The attachment's sandbox policy would also disable the browser's built-in PDF viewer.
      headers.delete('content-security-policy');
      headers.set('content-disposition', 'inline');
    }
    return new Response(file.body, { status: 200, headers });
  } catch (err) {
    const f = failureOf(err);
    return plain(
      f.status === 409 || f.status === 404
        ? `This PDF is not available to ${mode}. It may still be preparing or scanning, or it did not pass the scan.`
        : f.message,
      f.status >= 400 && f.status < 500 ? f.status : 502,
    );
  }
}
