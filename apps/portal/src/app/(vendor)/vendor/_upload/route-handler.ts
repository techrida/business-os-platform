import { ApiError } from '@/lib/api';
import { uploadVendorFile, type VendorUploadKind } from '@/lib/api.vendor-writes';
import { getEnv } from '@/lib/env';
import { SessionUnavailableError, SESSION_UNAVAILABLE_MESSAGE } from '@/lib/session-unavailable';
import { getSession, type Session } from '@/lib/session';

import { fileProblem } from './rules';

function reply(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * Receives one file from a vendor form and stores it through the API's portal upload. It is a
 * route handler, not a server action, because a server action's request body is capped far below
 * the 25 MB file limit. The file is the raw request body with its own content type, and the name
 * travels percent-encoded in `x-file-name`; the body is streamed on, never buffered. Route
 * handlers run no layout, so the layout's vendor check does not cover this: it checks the Origin
 * (the cookie is SameSite=Lax, and the Origin check is the second wall, as on sign-out), the
 * session, and that the session is a vendor's, before any call to the API. The browser gets back
 * the document id and the name it sent, never the version id or the upload path.
 */
export async function handleVendorUpload(req: Request, kind: VendorUploadKind): Promise<Response> {
  if (req.headers.get('origin') !== new URL(getEnv().PORTAL_PUBLIC_URL).origin) {
    return reply({ error: 'Forbidden' }, 403);
  }
  let session: Session | null;
  try {
    session = await getSession();
  } catch (err) {
    // A session store outage is retryable: answer 503 rather than a 500 or a sign-in prompt.
    if (!(err instanceof SessionUnavailableError)) throw err;
    const response = reply({ error: SESSION_UNAVAILABLE_MESSAGE }, 503);
    response.headers.set('retry-after', '1');
    return response;
  }
  if (!session) return reply({ error: 'Sign in to upload a file.' }, 401);
  if (session.orgKind !== 'vendor') return reply({ error: 'Forbidden' }, 403);

  let filename = '';
  try {
    filename = decodeURIComponent(req.headers.get('x-file-name') ?? '');
  } catch {
    return reply({ error: 'The file name could not be read.' }, 400);
  }
  const mime = (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const lengthHeader = req.headers.get('content-length');
  const size = lengthHeader === null || lengthHeader.trim() === '' ? NaN : Number(lengthHeader);
  if (!Number.isSafeInteger(size)) return reply({ error: 'The file size is missing.' }, 411);
  const problem = fileProblem({ name: filename, type: mime, size });
  if (problem !== null) return reply({ error: problem }, 422);
  if (req.body === null) return reply({ error: 'The file is empty.' }, 422);

  try {
    const { documentId } = await uploadVendorFile(session, kind, {
      filename,
      mime,
      size,
      body: req.body,
    });
    return reply({ documentId, filename }, 200);
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 0;
    if (status === 401) return reply({ error: 'Sign in to upload a file.' }, 401);
    if (status === 403) return reply({ error: 'Your account cannot send files right now.' }, 403);
    if (status === 413) return reply({ error: 'That file is too large.' }, 413);
    if (status === 415) {
      return reply({ error: 'That file type is not accepted. Use a PDF or a picture.' }, 415);
    }
    if (status >= 400 && status < 500) {
      return reply({ error: 'That file was not accepted. Try another file.' }, 422);
    }
    return reply({ error: 'We could not upload that file just now. Please try again.' }, 502);
  }
}
